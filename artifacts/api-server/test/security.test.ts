import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import express from "express";
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import twilio from "twilio";
import { rows, resetDatabase, writes } from "./fake-db";
import { logs, emitted, resetLogs } from "./capture-logger";
import { aiCalls, aiBehavior } from "./fake-ai";
import { providerHttpError } from "../src/lib/log-redaction";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveUser,
  signToken,
  requireSuperadmin,
} from "../src/middleware/auth";
import authPublic from "../src/routes/auth-public";
import authRouter from "../src/routes/auth";
import twilioRouter from "../src/routes/twilio";
import exotelRouter from "../src/routes/exotel";
import callsRouter from "../src/routes/calls";
import dialRouter from "../src/routes/dial";
import { crmEventBus } from "../src/lib/crm-event-bus";
import { initWebSocketServer } from "../src/lib/crm-ws-server";
import {
  createMediaSessions,
  verifyTwilioUpgrade,
  mediaSessionStore,
  bindTwilioCallSid,
  mediaPublicUrl,
  type MediaSessionStore,
} from "../src/lib/media-session";
import { createMediaUpgrade } from "../src/lib/media-ws-auth";
import {
  activateMediaPipeline,
  handleExotelStreamUpgrade,
} from "../src/lib/twilio-ws-server";

after(() => {
  for (const timer of (globalThis as any).__dialogTestIntervals)
    clearInterval(timer);
});

const sid = (prefix: string, value: string) => prefix + value.repeat(32);
const account = sid("AC", "a"),
  callSid = sid("CA", "a"),
  streamSid = sid("MZ", "a");
const keyA = "dk_live_" + "a".repeat(64),
  keyB = "dk_live_" + "b".repeat(64);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for test effect");
}

beforeEach(() => {
  resetDatabase();
  resetLogs();
  aiCalls.length = 0;
  rows.users = [
    { id: 10, isSuperadmin: true },
    { id: 20, isSuperadmin: false },
  ];
  rows.tenants = [
    {
      id: 1,
      ownerId: 10,
      status: "active",
      slug: "a",
      telephonyType: "TWILIO",
    },
    {
      id: 2,
      ownerId: 20,
      status: "active",
      slug: "b",
      telephonyType: "TWILIO",
    },
  ];
  rows.tenant_users = [
    {
      id: 100,
      tenantId: 1,
      userId: null,
      role: "manager",
      email: "member@example.test",
      isActive: true,
      name: "Fake member",
    },
  ];
  rows.tenant_sessions = [
    {
      id: 1,
      token: "a".repeat(64),
      tenantUserId: 100,
      tenantId: 1,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    },
  ];
  rows.crm_api_keys = [
    {
      id: 1,
      keyHash: hash(keyA),
      userId: 10,
      tenantId: 1,
      scopes: ["calls:read"],
      isActive: true,
    },
    {
      id: 2,
      keyHash: hash(keyB),
      userId: 20,
      tenantId: 2,
      scopes: ["*"],
      isActive: true,
    },
  ];
  rows.agent_configs = [
    {
      userId: 10,
      twilioAccountSid: account,
      twilioAuthToken: "fake-provider-auth-token",
      phoneNumber: "+15550000001",
      twilioTwimlAppSid: sid("AP", "a"),
      greeting: "Fake greeting",
      language: "en-US",
      aiModel: "gpt-4o-mini",
      voice: "nova",
    },
    {
      userId: 20,
      twilioAccountSid: sid("AC", "b"),
      twilioAuthToken: "fake-provider-auth-token-b",
      phoneNumber: "+15550000002",
    },
  ];
  rows.call_logs = [
    {
      id: 1,
      userId: 10,
      callSid,
      direction: "outbound",
      endedAt: null,
      startedAt: new Date(),
      liveTranscript: [],
      phone: "+15550000009",
    },
    {
      id: 2,
      userId: 20,
      callSid: sid("CA", "b"),
      direction: "outbound",
      endedAt: null,
      startedAt: new Date(),
      liveTranscript: [],
    },
  ];
});

async function httpHarness(app: any, t: any) {
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { server, base: `http://127.0.0.1:${(server.address() as any).port}` };
}
function collect(ws: WebSocket) {
  const messages: any[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  return messages;
}
async function connect(url: string, t: any, headers?: any) {
  const ws = new WebSocket(url, { headers });
  const messages = collect(ws);
  t.after(() => ws.terminate());
  await once(ws, "open");
  return { ws, messages };
}
async function denied(url: string, headers?: any) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      ws.terminate();
      resolve(res.statusCode!);
    });
    ws.on("open", () => {
      ws.terminate();
      reject(new Error("Unexpected authorized socket"));
    });
    ws.on("error", () => {});
  });
}
const event = (callId: number, value: string, userId = 999) => ({
  type: "call.turn" as const,
  callId,
  userId,
  data: { transcript: value, phone: "+15550000009" },
  metadata: { fake: true },
  timestamp: new Date().toISOString(),
});

test("header-only identities never authenticate in any environment; no privileged user is created", async (t) => {
  const app = express();
  app.use(resolveUser);
  app.get("/", (_req, res) => res.json({ ok: true }));
  const { base } = await httpHarness(app, t);
  for (const env of ["production", "development", ""]) {
    process.env.NODE_ENV = env;
    for (const value of ["10", "superadmin", "malformed"])
      assert.equal(
        (
          await fetch(base, {
            headers: {
              "x-replit-user-id": value,
              "x-replit-user-name": "admin",
            },
          })
        ).status,
        401,
      );
  }
  process.env.NODE_ENV = "test";
  assert.equal(writes, 0);
});

test("login, JWT membership binding, principal privilege and logout use actual routes", async (t) => {
  rows.tenant_users[0].passwordHash = await bcrypt.hash(
    "fake-login-password",
    4,
  );
  const app = express();
  app.use(express.json());
  app.use(authPublic);
  app.use(resolveUser);
  app.use(authRouter);
  app.get("/platform", requireSuperadmin, (_req, res) =>
    res.json({ ok: true }),
  );
  const { base } = await httpHarness(app, t);
  const login = await fetch(base + "/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "member@example.test",
      password: "fake-login-password",
    }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const headers = { authorization: `Bearer ${token}` };
  const me = await (await fetch(base + "/auth/me", { headers })).json();
  assert.equal(me.role, "manager");
  assert.equal(me.isSuperadmin, false); // owner is a superadmin, member is not
  assert.equal((await fetch(base + "/platform", { headers })).status, 403);
  rows.tenant_users[0].userId = 10;
  assert.equal((await fetch(base + "/platform", { headers })).status, 200);
  const session = rows.tenant_sessions.at(-1);
  session.tenantId = 2;
  assert.equal((await fetch(base + "/auth/me", { headers })).status, 401);
  session.tenantId = 1;
  session.tenantUserId = 999;
  assert.equal((await fetch(base + "/auth/me", { headers })).status, 401);
  session.tenantUserId = 100;
  session.expiresAt = new Date(0);
  assert.equal((await fetch(base + "/auth/me", { headers })).status, 401);
  session.expiresAt = new Date(Date.now() + 60_000);
  assert.equal(
    (await fetch(base + "/auth/logout", { method: "POST", headers })).status,
    200,
  );
  assert.equal((await fetch(base + "/auth/me", { headers })).status, 401);
});

test("malformed/expired JWTs, revoked sessions, disabled members and unexpected roles fail", async (t) => {
  const app = express();
  app.use(resolveUser);
  app.get("/", (_req, res) => res.json({ ok: true }));
  const { base } = await httpHarness(app, t);
  const request = (token: string) =>
    fetch(base, {
      headers: { authorization: `Bearer ${token}`, "x-replit-user-id": "10" },
    });
  for (const token of [
    "invalid",
    jwt.sign(
      { tenantUserId: "100", jti: "a".repeat(64) },
      process.env.JWT_SECRET!,
      { expiresIn: "1h" },
    ),
    jwt.sign(
      { tenantUserId: 100, jti: "a".repeat(64) },
      process.env.JWT_SECRET!,
      { expiresIn: -1 },
    ),
    jwt.sign(
      { tenantUserId: 100, jti: "a".repeat(64) },
      process.env.JWT_SECRET!,
    ),
  ])
    assert.equal((await request(token)).status, 401);
  const valid = signToken({ tenantUserId: 100, jti: "a".repeat(64) });
  rows.tenant_sessions[0].revokedAt = new Date();
  assert.equal((await request(valid)).status, 401);
  rows.tenant_sessions[0].revokedAt = null;
  rows.tenant_users[0].isActive = false;
  assert.equal((await request(valid)).status, 401);
  rows.tenant_users[0].isActive = true;
  rows.tenant_users[0].role = "superadmin";
  assert.equal((await request(valid)).status, 401);
});

test("CRM actual messages enforce tenant, call ownership, scopes, ordering and cleanup", async (t) => {
  const { server, base } = await httpHarness(express(), t);
  const before = crmEventBus.listenerCount("call-event");
  const dispose = initWebSocketServer(server);
  t.after(dispose);
  const a = await connect(
    base.replace("http", "ws") + `/ws/crm/calls?apiKey=${keyA}`,
    t,
  );
  const b = await connect(
    base.replace("http", "ws") + `/ws/crm/calls/2?apiKey=${keyB}`,
    t,
  );
  await until(() => a.messages.length === 1 && b.messages.length === 1);
  crmEventBus.emitCallEvent(event(2, "tenant-B", 10));
  crmEventBus.emitCallEvent(event(1, "tenant-A-first", 20));
  crmEventBus.emitCallEvent(event(1, "tenant-A-second", 20));
  await until(() => a.messages.length === 3 && b.messages.length === 2);
  assert.deepEqual(
    a.messages.slice(1).map((e) => e.data.transcript),
    ["tenant-A-first", "tenant-A-second"],
  );
  assert.equal(a.messages[1].userId, 10);
  assert.equal(a.messages[1].data.phone, "+15550000009");
  assert.deepEqual(a.messages[1].metadata, { fake: true });
  for (const id of ["2", "999", "bad", "0", "1extra", "1/extra"])
    assert.equal(
      await denied(
        base.replace("http", "ws") + `/ws/crm/calls/${id}?apiKey=${keyA}`,
      ),
      404,
    );
  rows.crm_api_keys[0].scopes = ["calls:write"];
  assert.equal(
    await denied(base.replace("http", "ws") + `/ws/crm/calls?apiKey=${keyA}`),
    403,
  );
  const closed = once(a.ws, "close");
  crmEventBus.emitCallEvent(event(1, "forbidden"));
  assert.equal((await closed)[0], 1008);
  dispose();
  assert.equal(crmEventBus.listenerCount("call-event"), before);
});

test("CRM revoked/inactive keys and suspended/ambiguous tenants fail closed, including idle sockets", async (t) => {
  const { server, base } = await httpHarness(express(), t);
  const url = base.replace("http", "ws") + `/ws/crm/calls?apiKey=${keyA}`;
  const dispose = initWebSocketServer(server, { intervalMs: 20 });
  t.after(dispose);
  rows.crm_api_keys[0].isActive = false;
  assert.equal(await denied(url), 401);
  rows.crm_api_keys[0].isActive = true;
  const a = await connect(url, t);
  const closed = once(a.ws, "close");
  rows.tenants[0].status = "suspended";
  assert.equal((await closed)[0], 1008);
  assert.equal(await denied(url), 403);
  rows.tenants[0].status = "active";
  const b = await connect(url, t);
  const revoked = once(b.ws, "close");
  rows.crm_api_keys[0].isActive = false;
  assert.equal((await revoked)[0], 1008);
  rows.crm_api_keys[0].isActive = true;
  rows.tenants.push({ id: 3, ownerId: 10, status: "active" });
  assert.equal(
    await denied(base.replace("http", "ws") + `/ws/crm/calls/1?apiKey=${keyA}`),
    404,
  );
});

test("CRM validation database failures send no customer data and close 1011", async (t) => {
  const { server, base } = await httpHarness(express(), t);
  const dispose = initWebSocketServer(server, {
    revalidateCrmIdentity: async () => {
      throw new Error("database unavailable");
    },
  });
  t.after(dispose);
  const a = await connect(
    base.replace("http", "ws") + `/ws/crm/calls?apiKey=${keyA}`,
    t,
  );
  await until(() => a.messages.length === 1);
  const closed = once(a.ws, "close");
  crmEventBus.emitCallEvent(event(1, "private"));
  assert.equal((await closed)[0], 1011);
  assert.equal(a.messages.length, 1);
});

function memorySessions() {
  const sessions = new Map<number, any>();
  let clock = new Date();
  let finalized = 0;
  const store: MediaSessionStore = {
    binding: (callId) => mediaSessionStore.binding(callId),
    get: async (id) => (sessions.get(id) ? { ...sessions.get(id) } : undefined),
    insert: async (row) => {
      if (!sessions.has(row.callLogId)) sessions.set(row.callLogId, { ...row });
    },
    claim: async (row, stream, now) => {
      const value = sessions.get(row.callLogId);
      if (!value || value.state !== "pending" || value.expiresAt <= now)
        return false;
      value.state = "active";
      value.streamSid = stream;
      value.claimedAt = now;
      return true;
    },
    close: async (id) => {
      const row = [...sessions.values()].find((s) => s.id === id);
      if (row?.state !== "active") return false;
      row.state = "closed";
      return true;
    },
  };
  return {
    sessions,
    store,
    service: createMediaSessions(store, () => clock),
    advance: () => {
      clock = new Date(clock.getTime() + 121_000);
    },
    finalize: async () => {
      finalized++;
    },
    get finalized() {
      return finalized;
    },
  };
}
const start = (token: string, changes = {}) => ({
  accountSid: account,
  callSid,
  streamSid,
  customParameters: { mediaCredential: token },
  mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
  ...changes,
});
async function mediaHarness(
  t: any,
  activate = async (_ws: any, _ctx: any, _start: any) => {},
) {
  const state = memorySessions();
  const { server, base } = await httpHarness(express(), t);
  const gate = createMediaUpgrade(activate, state.finalize, {
    sessions: state.service,
    handshakeMs: 80,
  });
  server.on("upgrade", gate.upgrade);
  t.after(gate.close);
  const path = "/ws/crm/calls/twilio-media-stream/1";
  const headers = {
    "x-twilio-signature": twilio.getExpectedTwilioSignature(
      "fake-provider-auth-token",
      mediaPublicUrl(path, true),
      {},
    ),
  };
  return { state, url: base.replace("http", "ws") + path, headers };
}
function handshake(ws: WebSocket, data: any) {
  ws.send(JSON.stringify({ event: "connected" }));
  ws.send(JSON.stringify({ event: "start", start: data }));
}

test("Twilio media rejects numeric-ID-only and forged upgrades without side effects", async (t) => {
  let activations = 0;
  const h = await mediaHarness(t, async () => {
    activations++;
  });
  assert.equal(await denied(h.url), 403);
  assert.equal(await denied(h.url, { "x-twilio-signature": "invalid" }), 403);
  assert.equal(await denied(h.url + "?callLogId=1", h.headers), 403);
  assert.equal(activations, 0);
  assert.equal(h.state.finalized, 0);
  assert.equal(writes, 0);
  assert.equal(aiCalls.length, 0);
});

test("media credentials bind call/account/provider, expire, survive service reconstruction and claim atomically", async () => {
  const h = memorySessions();
  const token = await h.service.issue(1);
  assert.equal(await h.service.issue(1), token);
  for (const altered of [
    start(""),
    start("invalid"),
    start(token, { callSid: sid("CA", "b") }),
    start(token, { accountSid: sid("AC", "b") }),
  ])
    await assert.rejects(h.service.authenticate(1, altered));
  await assert.rejects(h.service.authenticate(2, start(token)));
  h.sessions.get(1).provider = "exotel";
  await assert.rejects(h.service.authenticate(1, start(token)));
  h.sessions.get(1).provider = "twilio";
  const results = await Promise.allSettled([
    h.service.authenticate(1, start(token)),
    h.service.authenticate(1, start(token)),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  await assert.rejects(
    createMediaSessions(h.store).authenticate(1, start(token)),
  );
  await h.service.close(h.sessions.get(1).id);
  await assert.rejects(h.service.authenticate(1, start(token)));
  const expired = memorySessions();
  const credential = await expired.service.issue(1);
  expired.advance();
  await assert.rejects(expired.service.authenticate(1, start(credential)));
  const ended = memorySessions();
  const pending = await ended.service.issue(1);
  rows.call_logs[0].endedAt = new Date();
  await assert.rejects(ended.service.authenticate(1, start(pending)));
});

test("expired credentials and database failures are denied on real sockets without finalization", async (t) => {
  let activations = 0;
  const h = await mediaHarness(t, async () => {
    activations++;
  });
  const token = await h.state.service.issue(1);
  h.state.advance();
  const a = await connect(h.url, t, h.headers);
  const closed = once(a.ws, "close");
  handshake(a.ws, start(token));
  assert.equal((await closed)[0], 1008);
  h.state.store.get = async () => {
    throw new Error("fake database failure");
  };
  const b = await connect(h.url, t, h.headers);
  const failed = once(b.ws, "close");
  handshake(b.ws, start(token));
  assert.equal((await failed)[0], 1008);
  assert.equal(activations, 0);
  assert.equal(h.state.finalized, 0);
  assert.equal(writes, 0);
});

test("unauthenticated frames, wrong start IDs, missing credentials, timeout and oversized frames never activate/finalize", async (t) => {
  let activations = 0;
  const h = await mediaHarness(t, async () => {
    activations++;
  });
  const credential = await h.state.service.issue(1);
  for (const data of [
    { event: "media", media: { payload: "AAAA" } },
    { event: "dtmf", dtmf: { digit: "1" } },
    { event: "stop" },
    { event: "start", start: start(credential) },
  ]) {
    const { ws } = await connect(h.url, t, h.headers);
    const closed = once(ws, "close");
    ws.send(JSON.stringify(data));
    assert.equal((await closed)[0], 1008);
  }
  for (const payload of [
    start(""),
    start(credential, { callSid: sid("CA", "f") }),
  ]) {
    const { ws } = await connect(h.url, t, h.headers);
    const closed = once(ws, "close");
    handshake(ws, payload);
    assert.equal((await closed)[0], 1008);
  }
  const timeout = await connect(h.url, t, h.headers);
  assert.equal((await once(timeout.ws, "close"))[0], 1008);
  const large = await connect(h.url, t, h.headers);
  const closed = once(large.ws, "close");
  large.ws.send("a".repeat(17 * 1024));
  assert.equal((await closed)[0], 1009);
  assert.equal(activations, 0);
  assert.equal(h.state.finalized, 0);
  assert.equal(writes, 0);
  assert.equal(aiCalls.length, 0);
});

test("valid media activates once; replay, duplicate start, stop/close and late shutdown are safe", async (t) => {
  let activations = 0;
  let ctx: any;
  const h = await mediaHarness(t, async (ws, context) => {
    activations++;
    ctx = context;
    ws.send(JSON.stringify({ event: "authorized" }));
    ws.on("message", (raw) => {
      if (JSON.parse(raw.toString()).event === "stop") {
        void context.shutdown();
        ws.close();
      }
    });
  });
  const token = await h.state.service.issue(1);
  const a = await connect(h.url, t, h.headers);
  handshake(a.ws, start(token));
  await until(() => a.messages.length === 1);
  const b = await connect(h.url, t, h.headers);
  const deniedClose = once(b.ws, "close");
  handshake(b.ws, start(token));
  assert.equal((await deniedClose)[0], 1008);
  assert.equal(activations, 1);
  assert.equal(h.state.finalized, 0);
  const closed = once(a.ws, "close");
  a.ws.send(JSON.stringify({ event: "stop" }));
  await closed;
  await ctx.shutdown();
  await until(() => h.state.finalized === 1);
  assert.equal(ctx.isActive(), false);
});

test("verified Twilio issuer routes protect inbound/outbound/widget and return custom credentials", async (t) => {
  // The real issuer uses the actual DB adapter; only one-time claim SQL is
  // separately tested through the store boundary/PostgreSQL integration suite.
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(twilioRouter);
  const { base } = await httpHarness(app, t);
  const post = (path: string, body: Record<string, string>, signed = true) =>
    fetch(base + path, {
      method: "POST",
      body: new URLSearchParams(body),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(signed
          ? {
              "x-twilio-signature": twilio.getExpectedTwilioSignature(
                "fake-provider-auth-token",
                mediaPublicUrl(path),
                body,
              ),
            }
          : {}),
      },
    });
  const common = {
    AccountSid: account,
    CallSid: callSid,
    To: "+15550000001",
    From: "+15550000009",
  };
  for (const path of [
    "/twilio/inbound",
    "/twilio/outbound-voice?callLogId=1",
    "/twilio/widget-voice",
  ])
    assert.equal((await post(path, common, false)).status, 403);
  assert.equal(writes, 0);
  // Router is mounted at root in tests, so the canonical signed path is root too.
  const outbound = await post("/twilio/outbound-voice?callLogId=1", common);
  assert.equal(outbound.status, 200);
  const xml = await outbound.text();
  assert.match(xml, /name="mediaCredential"/);
  assert.match(
    xml,
    /wss:\/\/dialog.test\/ws\/crm\/calls\/twilio-media-stream\/1/,
  );
  assert.equal(
    await (await post("/twilio/outbound-voice?callLogId=1", common)).text(),
    xml,
  );
  assert.equal(
    (
      await post("/twilio/outbound-voice?callLogId=1", {
        ...common,
        CallSid: sid("CA", "b"),
      })
    ).status,
    403,
  );
  assert.equal(rows.call_logs[0].callSid, callSid);
  const inboundBody = { ...common, CallSid: sid("CA", "c") };
  const inbound = await post("/twilio/inbound", inboundBody);
  assert.equal(inbound.status, 200);
  assert.match(await inbound.text(), /mediaCredential/);
  assert.equal((await post("/twilio/inbound", inboundBody)).status, 200);
  assert.equal(
    rows.call_logs.filter((r) => r.callSid === inboundBody.CallSid).length,
    1,
  );
  assert.equal(
    (await post("/twilio/widget-voice", { ...common, userId: "10" })).status,
    403,
  );
  const widget = await post("/twilio/widget-voice", {
    ...common,
    CallSid: sid("CA", "d"),
    ApplicationSid: sid("AP", "a"),
  });
  assert.equal(widget.status, 200);
  assert.match(await widget.text(), /mediaCredential/);
});

test("outbound verified SID binding cannot be overwritten; missing/non-HTTPS canonical origins fail", async () => {
  rows.call_logs[0].callSid = null;
  await bindTwilioCallSid(1, callSid);
  await bindTwilioCallSid(1, callSid);
  await assert.rejects(bindTwilioCallSid(1, sid("CA", "b")));
  assert.equal(rows.call_logs[0].callSid, callSid);
  const previous = process.env.PUBLIC_BASE_URL;
  for (const value of [
    "",
    "http://dialog.test",
    "https://attacker@dialog.test",
    "https://dialog.test/path",
  ]) {
    process.env.PUBLIC_BASE_URL = value;
    assert.throws(() => mediaPublicUrl("/test"));
  }
  process.env.PUBLIC_BASE_URL = previous;
});

test("missing/invalid media signing keys never fall back to JWT or a hardcoded credential", async () => {
  const original = process.env.MEDIA_SESSION_SIGNING_KEY;
  try {
    for (const value of [
      "",
      "not-base64",
      Buffer.alloc(8).toString("base64"),
    ]) {
      process.env.MEDIA_SESSION_SIGNING_KEY = value;
      const state = memorySessions();
      await assert.rejects(state.service.issue(1));
      assert.equal(state.sessions.size, 0);
    }
  } finally {
    process.env.MEDIA_SESSION_SIGNING_KEY = original;
  }
});

test("media migration/snapshot are additive and match the new table contract", async () => {
  const directory = path.resolve("../../lib/db/drizzle");
  const previous = JSON.parse(
    await readFile(path.join(directory, "meta/0001_snapshot.json"), "utf8"),
  );
  const next = JSON.parse(
    await readFile(path.join(directory, "meta/0002_snapshot.json"), "utf8"),
  );
  const table = next.tables["public.call_media_sessions"];
  delete next.tables["public.call_media_sessions"];
  assert.deepEqual(next.tables, previous.tables);
  assert.equal(next.prevId, previous.id);
  assert.deepEqual(
    table.uniqueConstraints.call_media_sessions_call_log_id_unique.columns,
    ["call_log_id"],
  );
  const migration = await readFile(
    path.join(directory, "0002_call_media_sessions.sql"),
    "utf8",
  );
  assert.ok(
    !/\b(DROP|ALTER|INSERT|UPDATE|DELETE)\b/i.test(
      migration.replace(/ON DELETE CASCADE/g, ""),
    ),
  );
  for (const name of [
    ...Object.keys(table.foreignKeys),
    ...Object.keys(table.uniqueConstraints),
  ])
    assert.ok(migration.includes(`"${name}"`));
});

test("Exotel resolvers and protocol-shaped upgrades fail closed without state/provider work", async (t) => {
  const app = express();
  app.use(express.json());
  app.use(exotelRouter);
  const { server, base } = await httpHarness(app, t);
  server.on("upgrade", handleExotelStreamUpgrade);
  for (const path of [
    "/exotel/stream-url?callLogId=1",
    "/exotel/stream-url?callLogId=999",
    "/exotel/passthru",
  ]) {
    const res = await fetch(
      base + path,
      path.includes("passthru")
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ CustomField: "1", CallSid: callSid }),
          }
        : {},
    );
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Media access denied" });
  }
  assert.equal(
    await denied(base.replace("http", "ws") + "/ws/exotel/media-stream/1", {
      authorization: "Basic ZmFrZTpmYWtl",
    }),
    403,
  );
  assert.equal(writes, 0);
  assert.equal(aiCalls.length, 0);
});

test("real pipeline delivers greeting audio and transcript; closing suppresses late TTS writes", async (t) => {
  const config: any = {
    userId: 10,
    agentConfig: rows.agent_configs[0],
    script: null,
    callMeta: {
      userId: 10,
      callSid,
      liveTranscript: [],
      crmMetadata: null,
      externalCrmCallFlow: null,
      externalCrmContext: null,
    },
  };
  let synthesis = 0;
  const h = await mediaHarness(t, (ws, ctx, initial) =>
    activateMediaPipeline(ws, ctx, initial, {
      fetchConfig: async () => config,
      synthesize: async () => {
        synthesis++;
        return Buffer.alloc(320, 255);
      },
    }),
  );
  const token = await h.state.service.issue(1);
  const a = await connect(h.url, t, h.headers);
  handshake(a.ws, start(token));
  await until(() => a.messages.some((m) => m.event === "media"));
  assert.match(rows.call_logs[0].transcript, /Fake greeting/);
  assert.equal(synthesis, 1);
  assert.ok(logs.some((l) => l.msg === "Generating greeting TTS..." && l.callLogId === "1"));
  assert.ok(!emitted().includes("Fake greeting"), "greeting text must not be logged");
  assert.ok(!emitted().includes(token), "media credential must not be logged");
  const closed = once(a.ws, "close");
  a.ws.send(JSON.stringify({ event: "start", start: start(token) }));
  await closed;
  await until(() => h.state.finalized === 1);

  // New call fixture to test close during an already-dispatched synthesis.
  rows.call_logs[0].liveTranscript = [];
  rows.call_logs[0].transcript = "";
  config.callMeta.liveTranscript = [];
  let finish!: (value: Buffer) => void;
  const late = await mediaHarness(t, (ws, ctx, initial) =>
    activateMediaPipeline(ws, ctx, initial, {
      fetchConfig: async () => config,
      synthesize: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    }),
  );
  const lateToken = await late.state.service.issue(1);
  const b = await connect(late.url, t, late.headers);
  handshake(b.ws, start(lateToken));
  await until(() => !!finish);
  b.ws.close();
  await once(b.ws, "close");
  await until(() => late.state.finalized === 1);
  const count = writes;
  finish(Buffer.alloc(320, 255));
  await delay();
  assert.equal(writes, count);
  assert.equal(rows.call_logs[0].transcript, "");
});

test("authorization denial logging excludes fake credentials and customer payloads", async (t) => {
  const { server, base } = await httpHarness(express(), t);
  const dispose = initWebSocketServer(server);
  t.after(dispose);
  await denied(base.replace("http", "ws") + `/ws/crm/calls/2?apiKey=${keyA}`);
  const serialized = emitted();
  assert.ok(!serialized.includes(keyA));
  assert.ok(!serialized.includes("fake-provider-auth-token"));
  assert.ok(!serialized.includes("+15550000009"));
});

test("authorized dashboard details/transcripts and idempotent end controls retain owner boundaries", async (t) => {
  rows.tenant_users[0].role = "admin";
  rows.call_logs[0].transcript = "Fake authorized transcript";
  rows.call_logs[0].endedAt = new Date(); // End is already complete: never contact a provider.
  const app = express();
  app.use(express.json());
  app.use(resolveUser);
  app.use(callsRouter);
  app.use(dialRouter);
  const { base } = await httpHarness(app, t);
  const headers = {
    authorization: `Bearer ${signToken({ tenantUserId: 100, jti: "a".repeat(64) })}`,
  };
  const details = await fetch(base + "/calls/1", { headers });
  assert.equal(details.status, 200);
  assert.equal((await details.json()).transcript, "Fake authorized transcript");
  assert.equal((await fetch(base + "/calls/2", { headers })).status, 404);
  assert.equal(
    (await fetch(base + "/dial/calls/1/end", { method: "POST", headers }))
      .status,
    200,
  );
  assert.equal(
    (await fetch(base + "/dial/calls/2/end", { method: "POST", headers }))
      .status,
    404,
  );
});

test("authenticated media preserves DTMF, VAD/STT, streamed responses, CRM turns and transfer dispatch", async (t) => {
  const config: any = {
    userId: 10,
    agentConfig: {
      ...rows.agent_configs[0],
      language: "auto",
      languageMenuConfig: {
        enabled: true,
        options: [{ digit: "2", language: "en-US", label: "English" }],
        defaultLanguage: "en-US",
        timeoutSeconds: 12,
      },
    },
    script: null,
    callMeta: {
      userId: 10,
      callSid,
      liveTranscript: [],
      crmMetadata: null,
      externalCrmCallFlow: null,
      externalCrmContext: null,
    },
  };
  const heard: string[] = [];
  const transfers: any[] = [];
  const h = await mediaHarness(t, (ws, context, initial) =>
    activateMediaPipeline(ws, context, initial, {
      fetchConfig: async () => config,
      synthesize: async (text) => {
        heard.push(text);
        return Buffer.alloc(320, 255);
      },
      streamResponse: async function* () {
        yield "A fake authorized answer. ";
      },
      transfer: async (owner, request) => {
        transfers.push({ owner, request });
        return { success: true };
      },
    }),
  );
  const crmDispose = initWebSocketServer(
    (await httpHarness(express(), t)).server,
  );
  t.after(crmDispose);
  const turns: any[] = [];
  const capture = (e: any) => turns.push(e);
  crmEventBus.onCallEvent(capture);
  t.after(() => crmEventBus.off("call-event", capture));
  const token = await h.state.service.issue(1);
  const a = await connect(h.url, t, h.headers);
  handshake(a.ws, start(token));
  await until(() => heard.length === 1);
  a.ws.send(JSON.stringify({ event: "dtmf", streamSid, dtmf: { digit: "2" } }));
  await until(() => heard.length === 2);
  await delay(2100); // Existing pipeline's two-second VAD grace period is unchanged.
  const speak = () => {
    for (let i = 0; i < 12; i++)
      a.ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: Buffer.alloc(160, 0).toString("base64") },
        }),
      );
    for (let i = 0; i < 38; i++)
      a.ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: Buffer.alloc(160, 255).toString("base64") },
        }),
      );
  };
  speak();
  await until(() =>
    turns.some((e) => e.type === "call.turn" && e.data.role === "assistant"),
  );
  assert.ok(aiCalls.includes("stt"));
  assert.ok(heard.some((text) => text.includes("fake authorized answer")));
  assert.match(rows.call_logs[0].transcript, /I need a human agent/);
  assert.match(rows.call_logs[0].transcript, /fake authorized answer/);
  assert.ok(a.messages.some((m) => m.event === "media"));
  // Persisted/delivered conversation stays complete while logs carry metadata only.
  const turnLogs = emitted();
  assert.ok(logs.some((l) => l.msg === "Transcription complete" && l.transcriptLength > 0));
  assert.ok(logs.some((l) => l.msg === "Streaming sentence to TTS" && typeof l.chars === "number"));
  for (const content of ["I need a human agent", "fake authorized answer", "Fake greeting", token])
    assert.ok(!turnLogs.includes(content), `log output leaked: ${content}`);
  config.callMeta.crmMetadata = {
    __transferRules: {
      campaignHandoff: true,
      intents: [],
      humanRequestThreshold: 1,
      transferTo: "+15550000008",
    },
  };
  // Rules are captured at activation; a second authenticated call exercises the
  // same pipeline with transfer configuration present from the start.
  a.ws.close();
  await once(a.ws, "close");
  config.callMeta.liveTranscript = [];
  config.agentConfig.language = "en-US";
  const transferSession = await mediaHarness(t, (ws, ctx, initial) =>
    activateMediaPipeline(ws, ctx, initial, {
      fetchConfig: async () => config,
      synthesize: async () => Buffer.alloc(320, 255),
      transfer: async (owner, request) => {
        transfers.push({ owner, request });
        return { success: true };
      },
    }),
  );
  const nextToken = await transferSession.state.service.issue(1);
  const b = await connect(transferSession.url, t, transferSession.headers);
  handshake(b.ws, start(nextToken));
  await until(() => b.messages.some((m) => m.event === "media"));
  await delay(2100);
  for (let i = 0; i < 12; i++)
    b.ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: Buffer.alloc(160, 0).toString("base64") },
      }),
    );
  for (let i = 0; i < 38; i++)
    b.ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: Buffer.alloc(160, 255).toString("base64") },
      }),
    );
  await until(() => transfers.length === 1);
  assert.equal(transfers[0].owner, 10);
  assert.equal(transfers[0].request.callSid, callSid);
  assert.ok(logs.some((l) => l.msg === "Executing call transfer..." && l.isSipTarget === false));
  assert.ok(!emitted().includes("+15550000008"), "transfer target phone must not be logged");
  assert.ok(!emitted().includes("5550000008"));
});

test("voice-pipeline STT and TTS failures log sanitized errors without transcripts or credentials", async (t) => {
  const config: any = {
    userId: 10,
    agentConfig: { ...rows.agent_configs[0], language: "en-US" },
    script: null,
    callMeta: {
      userId: 10,
      callSid,
      liveTranscript: [],
      crmMetadata: null,
      externalCrmCallFlow: null,
      externalCrmContext: null,
    },
  };
  const echoed = "synthetic caller says my card is 4111 and phone +15550100123";
  aiBehavior.sttError = Object.assign(new Error("400 Invalid audio for prompt: " + echoed), {
    status: 400,
    code: "invalid_audio",
    headers: { authorization: "Bearer sk-test-" + "z".repeat(24), "x-request-id": "req_synthetic" },
    error: { message: echoed, param: "prompt" },
    request: { body: { prompt: echoed } },
  });
  t.after(() => {
    aiBehavior.sttError = null;
  });
  const h = await mediaHarness(t, (ws, ctx, initial) =>
    activateMediaPipeline(ws, ctx, initial, {
      fetchConfig: async () => config,
      synthesize: async () => {
        throw providerHttpError(
          "Sarvam TTS",
          400,
          JSON.stringify({ error: { code: "invalid_text", message: echoed } }),
        );
      },
    }),
  );
  const token = await h.state.service.issue(1);
  const a = await connect(h.url, t, h.headers);
  handshake(a.ws, start(token));
  await until(() => logs.some((l) => l.msg === "Error playing greeting"));
  const ttsFailure = logs.find((l) => l.msg === "Error playing greeting")!;
  assert.equal(ttsFailure.callLogId, "1");
  assert.equal(ttsFailure.err.type, "ProviderHttpError");
  assert.equal(ttsFailure.err.provider, "Sarvam TTS");
  assert.equal(ttsFailure.err.providerCode, "invalid_text");
  await delay(2100);
  for (let i = 0; i < 12; i++)
    a.ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: Buffer.alloc(160, 0).toString("base64") } }));
  for (let i = 0; i < 38; i++)
    a.ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: Buffer.alloc(160, 255).toString("base64") } }));
  await until(() => logs.some((l) => l.msg === "Error processing user utterance turn"));
  const failure = logs.find((l) => l.msg === "Error processing user utterance turn")!;
  assert.equal(failure.callLogId, "1");
  assert.equal(failure.err.status, 400);
  assert.equal(failure.err.code, "invalid_audio");
  assert.equal(failure.err.headers, undefined);
  assert.equal(failure.err.error, undefined);
  assert.equal(failure.err.request, undefined);

  const err = providerHttpError("Sarvam TTS", 400, JSON.stringify({ error: { code: "invalid_text", message: echoed } }));
  assert.equal(err.message, "Sarvam TTS API error 400");
  assert.equal(err.providerCode, "invalid_text");

  const out = emitted();
  for (const leaked of ["synthetic caller says", "+15550100123", "sk-test-", "req_synthetic", token])
    assert.ok(!out.includes(leaked), `log output leaked: ${leaked}`);
});

import "./postgres-media.test";
