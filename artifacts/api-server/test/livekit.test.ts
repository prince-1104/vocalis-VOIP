import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { VoiceSessions, localVoiceEnabled, serviceAuthorized, VoiceDenied, type Principal } from "../src/lib/livekit/sessions";
import { MockSipOrchestrator, requiredRate } from "../src/lib/livekit/sip-orchestration";
import { createLivekitRoutes } from "../src/routes/livekit";
import { mockLlmText } from "../src/lib/livekit/mock-llm";
import { applyMigrations, inspectSchema } from "@workspace/db/migrations";
import { configured, withDatabase, directory, pgRequire, migrateThrough } from "./pg-databases";
import { emitted, resetLogs } from "./capture-logger";

const localEnv = { NODE_ENV: "development", DIALOG_LOCAL_VOICE: "1", LIVEKIT_PROVIDER_MODE: "mock",
  DATABASE_URL: "postgresql://localhost/dialog_test_livekit" };
test("LiveKit development gate requires explicit isolated mock configuration and always rejects production", () => {
  assert.equal(localVoiceEnabled(localEnv), true);
  for (const patch of [{ NODE_ENV: "production" }, { DATABASE_URL: "postgresql://localhost/dialog" },
    { DATABASE_URL: "postgresql://remote/dialog_test_voice" }, { LIVEKIT_PROVIDER_MODE: "live" }, { DIALOG_LOCAL_VOICE: "0" },
    { DATABASE_URL: "postgresql://localhost/dialog_test_voice?options=override" }]) assert.equal(localVoiceEnabled({ ...localEnv, ...patch }), false);
});
test("worker credentials reject absent, malformed and incorrect secrets", () => {
  const secret = "a".repeat(43);
  for (const header of [undefined, secret, "Bearer " + "b".repeat(43), "Basic " + secret]) assert.equal(serviceAuthorized(header, secret), false);
  assert.equal(serviceAuthorized("Bearer " + secret, secret), true);
  assert.equal(serviceAuthorized("Bearer short", "short"), false);
});
test("new paid components have no invented rates; configured synthetic rates are accepted", () => {
  assert.throws(() => requiredRate({}, "stt:deepgram"), VoiceDenied);
  for (const rate of [NaN, Infinity, -1]) assert.throws(() => requiredRate({ "stt:deepgram": rate }, "stt:deepgram"));
  assert.equal(requiredRate({ "stt:deepgram": 0.0123 }, "stt:deepgram"), 0.0123);
});
test("actual LiveKit routes deny production and invalid service/webhook credentials without sensitive responses/logs", async t => {
  resetLogs();
  const app = express();
  const routes = createLivekitRoutes({ ...localEnv, LIVEKIT_WORKER_SECRET: "a".repeat(43) }, {} as VoiceSessions);
  app.use("/api", routes.internal);
  const production = createLivekitRoutes({ ...localEnv, NODE_ENV: "production" }, {} as VoiceSessions);
  app.use("/production", production.internal);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const [path, status] of [["/api/internal/livekit/eligible", 401], ["/api/livekit/webhook", 401], ["/production/internal/livekit/claim", 404]] as const) {
    const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/webhook+json", authorization: "Bearer private-sentinel" }, body: '{"transcript":"customer-sentinel"}' });
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /sentinel|signature|credential/i);
  }
  assert.doesNotMatch(emitted(), /private-sentinel|customer-sentinel/);
});
test("LLM route streams before generation completes, revalidates the claim per chunk and stops on revocation or client abort", async t => {
  resetLogs();
  const secret = "a".repeat(43), id = randomUUID();
  let calls = 0, revokeAfter = Infinity;
  const sessions = { validate: async (sid: string, claim: string) => {
    calls++;
    if (sid !== id || claim !== "claim-sentinel" || calls > revokeAfter) throw new VoiceDenied();
    return { id, mode: "mock" };
  } } as unknown as VoiceSessions;
  const app = express();
  app.use("/api", createLivekitRoutes({ ...localEnv, LIVEKIT_WORKER_SECRET: secret }, sessions).internal);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const messages = [{ role: "user", content: "customer-sentinel wants the detailed answer" }];
  const call = (signal?: AbortSignal) => fetch(`http://127.0.0.1:${(server.address() as any).port}/api/internal/livekit/${id}/llm`, {
    method: "POST", signal, body: JSON.stringify({ messages }),
    headers: { authorization: `Bearer ${secret}`, "x-dialog-claim": "claim-sentinel", "Content-Type": "application/json" } });
  const read = async (response: Response) => {
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let text = "", firstAt = 0;
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; firstAt ||= performance.now(); text += decoder.decode(chunk.value, { stream: true }); }
    return { events: text.split("\n\n").filter(Boolean), firstAt, endAt: performance.now() };
  };

  const started = performance.now();
  const full = await read(await call());
  assert.equal(full.events.at(-1), "data: [DONE]");
  const chunks = full.events.slice(0, -1).map(e => JSON.parse(e.slice(6)).text);
  assert.equal(chunks.join(""), mockLlmText(messages));
  assert.ok(chunks.length > 10, "word-sized chunks, not one accumulated answer");
  assert.ok(full.firstAt - started < (full.endAt - started) / 2, "first chunk is delivered long before generation completes");
  assert.equal(calls, 1 + chunks.length, "claim revalidated before every chunk");

  calls = 0; revokeAfter = 4;
  const revoked = await read(await call());
  assert.equal(revoked.events.length, 3, "no text after revocation");
  assert.ok(!revoked.events.includes("data: [DONE]"));

  calls = 0; revokeAfter = Infinity;
  const abort = new AbortController();
  const response = await call(abort.signal);
  await response.body!.getReader().read();
  abort.abort();
  await new Promise(r => setTimeout(r, 150));
  const afterAbort = calls;
  await new Promise(r => setTimeout(r, 300));
  assert.equal(calls, afterAbort, "generation stops when the worker disconnects");
  assert.ok(afterAbort < 1 + chunks.length);
  assert.doesNotMatch(emitted(), /customer-sentinel|claim-sentinel|detailed answer/);
});

async function database(t: any, run: (store: VoiceSessions, p: Principal[], pool: any) => Promise<void>) {
  await withDatabase(t, async (connect, url) => {
    const c = await connect();
    await migrateThrough(c, "0010_vobiz_sip_configuration");
    await applyMigrations(c, directory);
    assert.equal((await inspectSchema(c)).status, "ready");
    const { Pool } = pgRequire("pg");
    const pool = new Pool({ connectionString: url, max: 6 });
    try {
      const principals: Principal[] = [];
      for (let i = 0; i < 2; i++) {
        const owner = (await c.query("insert into users(name) values ('Fixture') returning id")).rows[0].id;
        const tenant = (await c.query("insert into tenants(name,slug,owner_id) values ('Fixture',$1,$2) returning id", [randomUUID(), owner])).rows[0].id;
        const member = (await c.query("insert into tenant_users(tenant_id,role,email) values ($1,'admin','fixture@local.invalid') returning id", [tenant])).rows[0].id;
        const token = String(i + 1).repeat(64);
        await c.query("insert into tenant_sessions(tenant_user_id,tenant_id,token,expires_at) values ($1,$2,$3,now()+interval '1 day')", [member, tenant, token]);
        principals.push({ tenantId: tenant, ownerId: owner, memberId: member, token });
      }
      await run(new VoiceSessions(pool), principals, pool);
    } finally { await pool.end(); }
  });
}
test("PostgreSQL LiveKit upgrade, tenant isolation, preview limits and independent-connection atomic admission", { skip: !configured }, async t => {
  await database(t, async (store, [a, b], pool) => {
    const s = await store.create(a);
    await assert.rejects(store.create(a), (e: any) => e.status === 409);
    await assert.rejects(store.get(s.id, b.tenantId), (e: any) => e.status === 404);
    await assert.rejects(store.get(randomUUID(), b.tenantId), (e: any) => e.status === 404);
    assert.equal(await store.eligible(s.id, "forged-room"), false);
    await assert.rejects(store.claim(s.id, "forged-room", "worker"));
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, (_, n) => new VoiceSessions(pool).claim(s.id, s.room, `worker-${n}`)));
    assert.equal(attempts.filter(r => r.status === "fulfilled").length, 1);
    const admitted = (attempts.find(r => r.status === "fulfilled") as PromiseFulfilledResult<any>).value;
    await store.validate(s.id, admitted.credential, true);
    await assert.rejects(store.validate(s.id, "wrong-claim"));
    await assert.rejects(new VoiceSessions(pool).claim(s.id, s.room, "replay"));
    assert.equal((await pool.query("select count(*) from call_logs")).rows[0].count, "0", "previews never fabricate a PSTN call");
    await pool.query("update tenant_sessions set revoked_at=now() where token=$1", [a.token]);
    await assert.rejects(store.validate(s.id, admitted.credential, true));
    await store.reconcile();
    assert.equal((await store.get(s.id, a.tenantId)).state, "closed");
    assert.equal(await store.close(s.id), null);
  });
});
test("PostgreSQL LiveKit expired/replayed claims, suspended tenants, ownership mismatches and stale leases fail closed", { skip: !configured }, async t => {
  await database(t, async (store, [p], pool) => {
    let s = await store.create(p);
    await pool.query("update livekit_sessions set admission_until=now()-interval '1 second' where id=$1", [s.id]);
    await assert.rejects(store.claim(s.id, s.room, "worker"));
    await store.reconcile(); s = await store.create(p);
    const admitted = await store.claim(s.id, s.room, "worker");
    await pool.query("update livekit_sessions set lease_until=now()+interval '2 seconds' where id=$1", [s.id]);
    await store.validate(s.id, admitted.credential, true);
    assert.equal((await pool.query("select lease_until > now()+interval '10 seconds' as renewed from livekit_sessions where id=$1", [s.id])).rows[0].renewed, true);
    await pool.query("update livekit_sessions set lease_until=now()-interval '1 second' where id=$1", [s.id]);
    // Workers retry transient renewal failures; a lapsed lease must answer 4xx so they stop instead of retrying.
    await assert.rejects(store.validate(s.id, admitted.credential, true), (e: any) => e.status === 403);
    await store.reconcile();
    s = await store.create(p);
    await pool.query("update tenants set status='suspended' where id=$1", [p.tenantId]);
    await assert.rejects(store.claim(s.id, s.room, "worker"));
    await store.reconcile();
    await pool.query("update tenants set status='active',owner_id=null where id=$1", [p.tenantId]);
    await assert.rejects(store.create(p));
  });
});
test("PostgreSQL LiveKit webhooks deduplicate, ignore forged participant metadata and finalize once", { skip: !configured }, async t => {
  await database(t, async (store, [p], pool) => {
    const s = await store.create(p);
    assert.equal(await store.event(randomUUID(), "unknown-room", undefined, true), null);
    assert.equal(await store.event(randomUUID(), s.room, "forged-participant", true), null);
    assert.equal((await store.get(s.id, p.tenantId)).state, "pending");
    const id = randomUUID();
    const outcomes = await Promise.all([store.event(id, s.room, s.participant, true), store.event(id, s.room, s.participant, true)]);
    assert.equal(outcomes.filter(Boolean).length, 1);
    assert.equal((await pool.query("select count(*) from livekit_operations")).rows[0].count, "1");
    await assert.rejects(store.claim(s.id, s.room, "worker"));
  });
});
test("PostgreSQL SIP durable ambiguous creation never retries; definitive evidence finalizes idempotently", { skip: !configured }, async t => {
  await database(t, async (_store, [p], pool) => {
    await pool.query("update tenants set telephony_type='VOBIZ_SIP' where id=$1", [p.tenantId]);
    const call = (await pool.query("insert into call_logs(user_id,phone,direction) values($1,'+12025550123','outbound') returning id", [p.ownerId])).rows[0].id;
    await pool.query("insert into livekit_trunks(id,tenant_id,provider,trunk_id,state) values($1,$2,'vobiz','mock-trunk','mock')", [randomUUID(), p.tenantId]);
    let creates = 0, policies = 0, reservations = 0;
    const settlements = new Map<string, string>();
    const service = new MockSipOrchestrator(pool, { mode: "mock", create: async () => { creates++; throw new Error("ambiguous provider timeout"); }, reconcile: async () => ({ state: "absent" }) }, {
      policies: async () => { policies++; }, reserve: async () => { reservations++; }, settle: async (key, result) => { settlements.set(key, result); },
    });
    const id = randomUUID(), rates = { "telephony:vobiz:outbound": 0.1 };
    assert.deepEqual(await service.attempt(p, call, id, rates), { state: "needs_reconciliation" });
    await service.attempt(p, call, id, rates);
    assert.equal(creates, 1); assert.equal(reservations, 1); assert.equal(policies, 2);
    assert.equal(settlements.get(id), "unknown");
    await Promise.all([service.reconcile(id, p.tenantId), service.reconcile(id, p.tenantId)]);
    assert.equal(settlements.get(id), "not_charged");
    assert.equal((await pool.query("select state from livekit_operations where id=$1", [id])).rows[0].state, "completed");
  });
});
