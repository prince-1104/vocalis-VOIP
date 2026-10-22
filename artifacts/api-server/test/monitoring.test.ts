import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once, EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { OperationalMetrics, startInfrastructureMonitoring, operations, providers, outcomes, metricNames } from "../src/lib/operational-metrics";
import { createReadiness, runStartup } from "../src/lib/schema-readiness";
import { createHealthRouter } from "../src/routes/health";
import { createMetricsRouter } from "../src/routes/metrics";
import { resolveUser } from "../src/middleware/auth";
import { alertCatalogue, validateAlertCatalogue } from "../src/lib/operational-alerts";
import { logger, emitted, resetLogs } from "./capture-logger";

async function serve(app: ReturnType<typeof express>, t: any) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

test("readiness caches healthy probes and detects runtime schema incompatibility", async () => {
  let now = 0, queries = 0, schemas = 0, schemaOk = true;
  const readiness = createReadiness({ query: async () => { queries++; return { rows: [{ ready: 1 }] }; } },
    { now: () => now, checkSchema: async () => { schemas++; return schemaOk; } });
  assert.equal((await readiness.check()).status, "starting");
  readiness.markReady();
  assert.equal((await readiness.check()).ready, true);
  await readiness.check(); assert.equal(queries, 1); assert.equal(schemas, 0);
  schemaOk = false; now = 60_000;
  assert.equal((await readiness.check()).ready, false); assert.equal(schemas, 1);
  now += 1_000; assert.equal((await readiness.check()).ready, false);
  schemaOk = true; now += 60_000; assert.equal((await readiness.check()).ready, true);
});

test("slow readiness remains bounded and single-flight even after repeated timeouts", async (t) => {
  let queries = 0, settle!: (value: { rows: any[] }) => void;
  const pending = new Promise<{ rows: any[] }>(resolve => { settle = resolve; });
  const readiness = createReadiness({ query: () => { queries++; return pending; } }, { probeTimeoutMs: 15, cacheMs: 0 });
  readiness.markReady();
  const app = express(); app.use(createHealthRouter(() => readiness.check(), 100));
  const base = await serve(app, t);
  const started = Date.now();
  const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(base + "/readyz")));
  assert.ok(Date.now() - started < 2_000);
  assert.ok(responses.every(r => r.status === 503));
  assert.equal((await fetch(base + "/readyz")).status, 503); assert.equal(queries, 1);
  assert.equal((await fetch(base + "/healthz")).status, 200);
  settle({ rows: [{ ready: 1 }] });
});

test("readiness rejects malformed responses and dependency exceptions without detail", async () => {
  for (const rows of [[], [{}], [{ ready: "1" }], [{ ready: 1 }, { ready: 1 }]]) {
    const r = createReadiness({ query: async () => ({ rows }) }); r.markReady();
    assert.deepEqual(await r.check(), { ready: false, status: "database_unavailable" });
  }
  const r = createReadiness({ query: async () => { throw new Error(randomUUID()); } }); r.markReady();
  assert.deepEqual(await r.check(), { ready: false, status: "database_unavailable" });
});

test("schema exceptions fail closed and are throttled without reusing a previous pass", async () => {
  let now = 0, checks = 0;
  const r = createReadiness({ query: async () => ({ rows: [{ ready: 1 }] }) }, {
    now: () => now, checkSchema: async () => { checks++; throw new Error("unavailable"); },
  });
  r.markReady(); assert.equal((await r.check()).ready, true);
  now = 60_000; assert.equal((await r.check()).ready, false);
  now += 1_000; assert.equal((await r.check()).ready, false); assert.equal(checks, 1);
  now += 60_000; assert.equal((await r.check()).ready, false); assert.equal(checks, 2);
});

test("public health bounds injected checks, sanitizes status and keeps liveness independent", async (t) => {
  const sentinel = randomUUID();
  for (const check of [async () => ({ ready: true, status: sentinel }), async () => { throw new Error(sentinel); }, () => new Promise<any>(() => {}), async () => null as any]) {
    const app = express(); app.use(createHealthRouter(check, 15)); const base = await serve(app, t);
    const response = await fetch(base + "/readyz");
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: "database_unavailable" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await (await fetch(base + "/healthz")).json(), { status: "ok" });
  }
});

test("startup schema refusal still prevents listening, workers and readiness", async () => {
  const calls: string[] = [];
  await assert.rejects(runStartup({ checkSchema: async () => { throw new Error("incompatible"); },
    prepare: async () => { calls.push("prepare"); }, listen: async () => { calls.push("listen"); },
    startWorkers: () => { calls.push("workers"); }, markReady: () => { calls.push("ready"); } }));
  assert.deepEqual(calls, []);
});

test("HTTP metrics use route templates, count finish once, aggregate denials and bound cardinality", async (t) => {
  const registry = new OperationalMetrics(), sentinel = randomUUID();
  const app = express(); app.use(registry.http());
  app.get("/items/:id", (_req, res) => res.status(403).end());
  app.get("/limited", (_req, res) => res.status(429).end());
  for (let i = 0; i < 180; i++) app.get(`/registered_${i}`, (_req, res) => res.end());
  app.use((_req, res) => res.status(401).end());
  const base = await serve(app, t);
  for (let i = 0; i < 30; i++) await fetch(`${base}/items/${sentinel}${i}?query=${sentinel}`);
  await fetch(base + "/limited"); await fetch(base + "/" + sentinel);
  for (let i = 0; i < 180; i++) await fetch(`${base}/registered_${i}`);
  const output = registry.render();
  assert.ok(!output.includes(sentinel));
  assert.match(output, /dialog_http_requests_total\{route="\/items\/:id",method="GET",status_class="4xx"\} 30/);
  for (const status of [401, 403, 429]) assert.match(output, new RegExp(`dialog_http_rejections_total\\{reason="${status}"\\}`));
  assert.match(output, /dialog_http_duration_seconds_bucket.*le="\+Inf"/);
  const routes = new Set([...output.matchAll(/route="([^"]*)"/g)].map(match => match[1]));
  assert.ok(routes.size <= 162); assert.ok(routes.has("other"));
  // Invalid domains cannot create unbounded operation/provider/outcome labels.
  for (let i = 0; i < 500; i++) registry.operation((sentinel + i) as any, sentinel as any)(sentinel as any);
  assert.ok(!registry.render().includes(sentinel));
});

test("metrics endpoint requires existing authentication and superadmin authorization", async (t) => {
  const denied = express(); denied.use(resolveUser); denied.use(createMetricsRouter());
  assert.equal((await fetch(await serve(denied, t) + "/superadmin/metrics")).status, 401);
  for (const permitted of [false, true]) {
    const app = express(); app.use((req, _res, next) => { req.isSuperadmin = permitted; next(); });
    app.use(createMetricsRouter()); const response = await fetch(await serve(app, t) + "/superadmin/metrics");
    assert.equal(response.status, permitted ? 200 : 403);
    if (permitted) { assert.match(response.headers.get("content-type")!, /text\/plain/); assert.equal(response.headers.get("cache-control"), "no-store"); }
  }
});

test("monitoring failures preserve HTTP responses, values and original exceptions", async (t) => {
  const registry = new OperationalMetrics(() => { throw new Error("sink unavailable"); });
  const expected = { success: true };
  assert.equal(await registry.measure("call_setup", async () => expected), expected);
  assert.equal(await registry.measure("transfer", async () => expected, "twilio", () => { throw new Error("classifier"); }), expected);
  const error = new Error("provider unavailable");
  await assert.rejects(registry.measure("stt", async () => { throw error; }, "openai"), e => e === error);
  const app = express(); app.use(registry.http()); app.get("/ok", (_req, res) => res.json(expected));
  assert.deepEqual(await (await fetch(await serve(app, t) + "/ok")).json(), expected);
  registry.mediaSession()(); registry.infrastructure({ totalCount: 1, idleCount: 0, waitingCount: 1 }, 0);
});

test("export failures return generic diagnostics and do not expose exceptions", async (t) => {
  const sentinel = randomUUID(); const registry = new OperationalMetrics();
  registry.render = () => { throw new Error(sentinel); };
  const app = express(); app.use((req, _res, next) => { req.isSuperadmin = true; next(); }); app.use(createMetricsRouter(registry));
  const response = await fetch(await serve(app, t) + "/superadmin/metrics");
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "Metrics unavailable" });
});

test("session cleanup and operation completion are idempotent; errors/timeouts are bounded", async () => {
  const registry = new OperationalMetrics();
  const close = registry.mediaSession(); close(); close();
  const finish = registry.operation("finalization", "twilio"); finish("error"); finish();
  await assert.rejects(registry.measure("stt", async () => { throw Object.assign(new Error("unavailable"), { name: "TimeoutError" }); }, "sarvam"));
  const output = registry.render();
  assert.match(output, /dialog_media_sessions_active 0/);
  assert.match(output, /dialog_media_disconnects_total 1/);
  assert.match(output, /operation="finalization",provider="twilio",outcome="error"\} 1/);
  assert.match(output, /operation="stt",provider="sarvam",outcome="timeout"/);
});

test("infrastructure sampling reuses pool, exposes aggregate pressure and removes listener", () => {
  const registry = new OperationalMetrics();
  const pool = Object.assign(new EventEmitter(), { totalCount: 2, idleCount: 0, waitingCount: 1, options: { max: 2 } });
  const stop = startInfrastructureMonitoring(pool, registry);
  assert.equal(pool.listenerCount("error"), 1); pool.emit("error", new Error(randomUUID()));
  const output = registry.render();
  assert.match(output, /dialog_db_pool_exhausted 1/); assert.match(output, /dialog_db_connection_errors_total 1/);
  assert.match(output, /dialog_process_memory_bytes\{kind="rss"\} \d+/);
  stop(); stop(); assert.equal(pool.listenerCount("error"), 0);
});

test("retry samples describe only the loaded batch and never delivery identities", () => {
  const registry = new OperationalMetrics();
  registry.retryBatch([{ nextRetryAt: new Date(Date.now() - 20_000) }]);
  assert.match(registry.render(), /dialog_webhook_retry_batch_size 1/);
  assert.match(registry.render(), /dialog_webhook_retry_batch_delay_seconds 20/);
  registry.retryBatch([]); assert.match(registry.render(), /dialog_webhook_retry_batch_delay_seconds 0/);
});

test("alert catalogue references declared signals and requires external evidence where absent", () => {
  assert.equal(validateAlertCatalogue(), true);
  assert.ok(alertCatalogue.length >= 10);
  assert.ok(alertCatalogue.every(rule => rule.response && rule.window && rule.rule));
  assert.ok(operations.length < 32 && providers.length < 10 && outcomes.length < 12 && metricNames.length < 32);
});

test("central logger redacts nested exception metadata for database, provider, webhook and job categories", () => {
  resetLogs();
  const sentinel = randomUUID();
  for (const event of ["database_probe", "provider_failure", "webhook_failure", "background_job_failure"]) {
    const err = Object.assign(new Error("Dependency unavailable"), { body: { transcript: sentinel, orderId: sentinel }, config: { password: sentinel }, code: "ECONNRESET" });
    logger.error({ event, err, payload: sentinel, authorization: sentinel, phone: sentinel }, "Operation failed");
  }
  assert.ok(!emitted().includes(sentinel));
  for (const event of ["database_probe", "provider_failure", "webhook_failure", "background_job_failure"]) assert.ok(emitted().includes(event));
});

test("recovery runbook uses actual versioned migration commands and marks verification gaps", async () => {
  const doc = await readFile("../../docs/production-readiness/monitoring-alerting-disaster-recovery.md", "utf8");
  const cli = await readFile("src/db-migrate.ts", "utf8");
  for (const command of ["status", "apply", "adopt"]) { assert.ok(cli.includes(`"${command}"`)); assert.ok(doc.includes(`db:migrate ${command}`)); }
  assert.match(doc, /restore drill.*outstanding/i); assert.match(doc, /external alert delivery.*unconfigured/i);
});
