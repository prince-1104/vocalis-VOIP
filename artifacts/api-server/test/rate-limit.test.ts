import { test, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import express from "express";
import bcrypt from "bcryptjs";
import twilio from "twilio";
import { rows, resetDatabase } from "./fake-db";
import { logs, emitted, resetLogs } from "./capture-logger";
import { safeErrorHandler } from "../src/lib/error-handler";
import {
  clientAddress,
  configureRateLimitingForTests,
  createMemoryRateLimitStore,
  createPostgresRateLimitStore,
  parseRateLimitSettings,
  rateLimit,
  resetRateLimitingForTests,
  RateLimitConfigError,
  type RateLimitPolicy,
  type RateLimitStore,
} from "../src/lib/rate-limit";
import { POLICIES, adminMutationRateLimit } from "../src/lib/rate-limit-policies";
import { parseTrustProxy, TrustProxyConfigError } from "../src/lib/trusted-proxy";
import authPublic from "../src/routes/auth-public";
import widgetRouter from "../src/routes/widget";
import crmRouter from "../src/routes/crm";
import campaignsRouter from "../src/routes/campaigns";
import twilioRouter from "../src/routes/twilio";

after(() => {
  for (const timer of (globalThis as any).__dialogTestIntervals) clearInterval(timer);
});

// All values are synthetic.
const PASSWORD = "fake-login-password-7f3a";
const EMAIL = "member@example.test";
const PHONE = "9876543210";
const CODE = "482915";
const sid = (prefix: string, value: string) => prefix + value.repeat(32);
const ACCOUNT_A = sid("AC", "a");
const TOKEN_A = "fake-twilio-auth-token-tenant-a";
const CALL_C = sid("CA", "c");
const CRM_KEY_A = "dk_live_" + "a".repeat(64);
const CRM_KEY_B = "dk_live_" + "b".repeat(64);
const WIDGET_KEY_A = "wk_fake_tenant_a";
const WIDGET_KEY_B = "wk_fake_tenant_b";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

const MINUTE = 60_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % (60 * MINUTE));
let now = T0;
let keys: string[] = [];
let passwordHash = "";

/** Shared store wrapper that records the counter keys written. */
function recording(inner: RateLimitStore): RateLimitStore {
  return { kind: inner.kind, add: (key, ...rest) => (keys.push(key), inner.add(key, ...rest)) };
}

before(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

beforeEach(() => {
  resetDatabase();
  resetLogs();
  resetRateLimitingForTests();
  now = T0;
  keys = [];
  configureRateLimitingForTests({ store: recording(createMemoryRateLimitStore(() => now)), clock: () => now });
  rows.users = [{ id: 10 }, { id: 20 }];
  rows.tenants = [
    { id: 1, ownerId: 10, status: "active", slug: "a", name: "Fake A", telephonyType: "TWILIO" },
    { id: 2, ownerId: 20, status: "active", slug: "b", name: "Fake B", telephonyType: "TWILIO" },
  ];
  rows.tenant_users = [
    { id: 100, tenantId: 1, userId: 10, role: "admin", email: EMAIL, isActive: true, name: "Fake member", passwordHash },
  ];
  rows.agent_configs = [
    { userId: 10, twilioAccountSid: ACCOUNT_A, twilioAuthToken: TOKEN_A, phoneNumber: "+15550000001", language: "en-US",
      aiModel: "gpt-4o-mini", voice: "nova", widgetApiKey: WIDGET_KEY_A, widgetEnabled: true, widgetVoiceEnabled: false },
    { userId: 20, twilioAccountSid: sid("AC", "b"), twilioAuthToken: "fake-token-b", phoneNumber: "+15550000002",
      language: "en-US", aiModel: "gpt-4o-mini", voice: "nova", widgetApiKey: WIDGET_KEY_B, widgetEnabled: true, widgetVoiceEnabled: false },
  ];
  rows.call_logs = [
    { id: 3, userId: 10, callSid: CALL_C, direction: "inbound", phone: "+15550000009", aiModel: "gpt-4o-mini",
      endedAt: null, startedAt: new Date(), liveTranscript: [] },
  ];
  rows.crm_api_keys = [
    { id: 1, keyHash: hash(CRM_KEY_A), userId: 10, tenantId: 1, scopes: ["*"], isActive: true },
    { id: 2, keyHash: hash(CRM_KEY_B), userId: 20, tenantId: 2, scopes: ["*"], isActive: true },
  ];
});

async function serve(app: express.Express, t: any): Promise<string> {
  app.use(safeErrorHandler());
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

function newApp(trustProxy: false | string[] = false) {
  const app = express();
  app.set("trust proxy", trustProxy);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  return app;
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function statuses(count: number, send: (i: number) => Promise<Response>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const res = await send(i);
    await res.arrayBuffer();
    out.push(res.status);
  }
  return out;
}

const testPolicy = (overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy => ({
  name: "test.policy",
  windowMs: MINUTE,
  max: 3,
  onStoreFailure: "closed",
  ...overrides,
});

// ── Core behavior ──────────────────────────────────────────────────────

test("within budget passes; excess returns 429 with Retry-After; the sliding window resets", async (t) => {
  const app = newApp();
  app.post("/x", rateLimit([{ policy: testPolicy(), identify: (req) => ["ip", clientAddress(req)] }]), (_req, res) =>
    res.json({ ok: true }),
  );
  const base = await serve(app, t);
  assert.deepEqual(await statuses(3, () => post(base + "/x", {})), [200, 200, 200]);
  const limited = await post(base + "/x", {});
  assert.equal(limited.status, 429);
  const retryAfter = Number(limited.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 120);
  assert.deepEqual(await limited.json(), {
    error: "rate_limited",
    message: "Too many requests. Please try again later.",
    retryAfterSeconds: retryAfter,
  });

  // At the start of the next window the full previous window still weighs in.
  now = T0 + MINUTE;
  assert.equal((await post(base + "/x", {})).status, 429);
  // Once the previous window has decayed out, the budget is restored.
  now = T0 + 3 * MINUTE;
  assert.deepEqual(await statuses(3, () => post(base + "/x", {})), [200, 200, 200]);
  assert.equal((await post(base + "/x", {})).status, 429);
});

test("several app instances sharing one store admit exactly max concurrent requests", async (t) => {
  const policy = testPolicy({ max: 10 });
  const bases: string[] = [];
  for (let i = 0; i < 3; i++) {
    const app = newApp();
    app.post("/x", rateLimit([{ policy, identify: () => ["shared"] }]), (_req, res) => res.json({ ok: true }));
    bases.push(await serve(app, t));
  }
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) => post(bases[i % 3] + "/x", {}).then(async (r) => (await r.arrayBuffer(), r.status))),
  );
  assert.equal(results.filter((s) => s === 200).length, 10);
  assert.equal(results.filter((s) => s === 429).length, 20);
});

test("store failure: fail-closed policies answer 503, fail-open policies serve; failures logged once without detail", async (t) => {
  const failing: RateLimitStore = {
    kind: "postgres",
    add: async () => {
      throw new Error("connect ECONNREFUSED fake-db-host password=fake-db-password");
    },
  };
  configureRateLimitingForTests({ store: failing });
  const app = newApp();
  app.post("/closed", rateLimit([{ policy: testPolicy({ name: "test.closed" }), identify: () => ["a"] }]), (_q, r) => r.json({ ok: true }));
  app.post("/open", rateLimit([{ policy: testPolicy({ name: "test.open", onStoreFailure: "open" }), identify: () => ["a"] }]), (_q, r) =>
    r.json({ ok: true }),
  );
  app.use("/api", authPublic);
  app.use("/api", widgetRouter);
  const base = await serve(app, t);

  const closed = await post(base + "/closed", {});
  assert.equal(closed.status, 503);
  assert.equal(closed.headers.get("retry-after"), "30");
  assert.equal((await closed.json()).error, "temporarily_unavailable");
  assert.equal((await post(base + "/open", {})).status, 200);

  // Critical protections stay closed during an outage; low-cost config stays open.
  assert.equal((await post(base + "/api/auth/login", { email: EMAIL, password: PASSWORD })).status, 503);
  assert.equal((await post(base + "/api/widget/crm/verification/start", { apiKey: WIDGET_KEY_A, phone: PHONE })).status, 503);
  assert.equal((await fetch(base + "/api/widget/config/unknown-key")).status, 404);

  const failures = logs.filter((l) => l.event === "rate_limit_store_unavailable");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "error");
  assert.doesNotMatch(emitted(), /ECONNREFUSED|fake-db-password|fake-db-host/);
});

test("PostgreSQL store: parses driver rows, times out instead of hanging, and rejects empty results", async () => {
  const queries: any[] = [];
  const ok = createPostgresRateLimitStore({ execute: async (q) => (queries.push(q), { rows: [{ current: "2", previous: "1" }] }) });
  assert.deepEqual(await ok.add("k", T0, MINUTE, 1), { current: 2, previous: 1 });
  assert.equal(queries.length, 1);

  const hanging = createPostgresRateLimitStore({ execute: () => new Promise(() => {}) }, { timeoutMs: 20 });
  await assert.rejects(hanging.add("k", T0, MINUTE, 1), /timeout/);

  const empty = createPostgresRateLimitStore({ execute: async () => ({ rows: [] }) });
  await assert.rejects(empty.add("k", T0, MINUTE, 1));
});

// ── Configuration ──────────────────────────────────────────────────────

test("rate-limit configuration fails safely and never echoes the configured value", () => {
  const key = Buffer.alloc(32, 5).toString("base64");
  assert.throws(() => parseRateLimitSettings({ NODE_ENV: "production" }), RateLimitConfigError);
  assert.throws(() => parseRateLimitSettings({ NODE_ENV: "production", RATE_LIMIT_HASH_KEY: key, RATE_LIMIT_STORE: "memory" }), /not allowed in production/);
  assert.throws(() => parseRateLimitSettings({ RATE_LIMIT_STORE: "redis" }), RateLimitConfigError);
  for (const bad of ["c2hvcnQ=", "not base64!", Buffer.alloc(16, 1).toString("base64")]) {
    assert.throws(
      () => parseRateLimitSettings({ RATE_LIMIT_HASH_KEY: bad }),
      (err: Error) => err instanceof RateLimitConfigError && !err.message.includes(bad),
    );
  }
  assert.equal(parseRateLimitSettings({ NODE_ENV: "production", RATE_LIMIT_HASH_KEY: key }).storeKind, "postgres");
  assert.equal(parseRateLimitSettings({}).hashKey.length, 32);
});

test("trust proxy must be explicit in production; permissive values are rejected", () => {
  assert.throws(() => parseTrustProxy({ NODE_ENV: "production" }), TrustProxyConfigError);
  assert.equal(parseTrustProxy({ NODE_ENV: "production", TRUST_PROXY: "none" }), false);
  assert.equal(parseTrustProxy({}), false);
  for (const bad of ["true", "*", "2", "0.0.0.0/0", "::/0", "10.0.0.0/4", "0.0.0.0", "proxy.example.test", "10.0.0.0/33"]) {
    assert.throws(
      () => parseTrustProxy({ NODE_ENV: "production", TRUST_PROXY: bad }),
      (err: Error) => err instanceof TrustProxyConfigError && !err.message.includes(bad),
      bad,
    );
  }
  assert.deepEqual(parseTrustProxy({ TRUST_PROXY: "loopback, 10.0.0.0/8, fd00::/8" }), ["loopback", "10.0.0.0/8", "fd00::/8"]);
});

// ── Client identity ────────────────────────────────────────────────────

test("spoofed X-Forwarded-For cannot bypass limits without a trusted proxy", async (t) => {
  const app = newApp(parseTrustProxy({ TRUST_PROXY: "none" }));
  app.use("/api", authPublic);
  const base = await serve(app, t);
  const results = await statuses(6, (i) =>
    post(base + "/api/auth/login", { email: EMAIL, password: "wrong-" + i }, { "x-forwarded-for": `203.0.113.${i + 1}` }),
  );
  assert.deepEqual(results, [401, 401, 401, 401, 401, 429]);
  // The correct password is still refused while the account/address budget is exhausted.
  assert.equal((await post(base + "/api/auth/login", { email: EMAIL, password: PASSWORD }, { "x-forwarded-for": "198.51.100.7" })).status, 429);
});

test("behind a trusted proxy, forged left-most X-Forwarded-For entries do not change identity", async (t) => {
  const app = newApp(parseTrustProxy({ TRUST_PROXY: "loopback" }));
  app.use("/api", widgetRouter);
  const base = await serve(app, t);
  // The proxy appends the real client (198.51.100.20); the caller controls the rest.
  const results = await statuses(21, (i) =>
    post(base + "/api/widget/crm/verification/start", {}, { "x-forwarded-for": `203.0.113.${i + 1}, 198.51.100.20` }),
  );
  assert.deepEqual(results.slice(0, 20), Array(20).fill(400));
  assert.equal(results[20], 429);
  // A different real client behind the same proxy has its own budget.
  assert.equal((await post(base + "/api/widget/crm/verification/start", {}, { "x-forwarded-for": "198.51.100.21" })).status, 400);
});

test("IPv6 clients are grouped by /64 so address rotation does not reset budgets", async (t) => {
  const app = newApp(parseTrustProxy({ TRUST_PROXY: "loopback" }));
  app.post("/x", rateLimit([{ policy: testPolicy(), identify: (req) => ["ip", clientAddress(req)] }]), (_q, r) => r.json({ ok: true }));
  const base = await serve(app, t);
  const results = await statuses(4, (i) => post(base + "/x", {}, { "x-forwarded-for": `2001:db8:1:2::${i + 1}` }));
  assert.deepEqual(results, [200, 200, 200, 429]);
  assert.equal((await post(base + "/x", {}, { "x-forwarded-for": "2001:db8:1:3::1" })).status, 200);
  assert.equal((await post(base + "/x", {}, { "x-forwarded-for": "::ffff:192.0.2.1" })).status, 200);
});

// ── Route policies ─────────────────────────────────────────────────────

test("login: failures are limited per account+address, successes are refunded, tenantSlug cannot pick a budget", async (t) => {
  const app = newApp();
  app.use("/api", authPublic);
  const base = await serve(app, t);
  const login = (body: object) => post(base + "/api/auth/login", body);

  // Successful logins never consume the failure budgets.
  assert.deepEqual(await statuses(8, () => login({ email: EMAIL, password: PASSWORD })), Array(8).fill(200));
  // Failures with varying tenantSlug, case and whitespace share one account budget.
  const variants = [{}, { tenantSlug: "a" }, { tenantSlug: "b" }, { tenantSlug: "nonexistent" }, { tenantSlug: "a" }];
  const failed = await statuses(5, (i) =>
    login({ email: i % 2 ? `  ${EMAIL.toUpperCase()} ` : EMAIL, password: "wrong", ...variants[i] }),
  );
  assert.deepEqual(failed, Array(5).fill(401));
  const limited = await login({ email: EMAIL, password: PASSWORD, tenantSlug: "b" });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  // Requests the limiter stops never reach the password check, so they do not
  // count as failures against the address: retrying a locked account cannot
  // lock the address out of other accounts.
  assert.deepEqual(await statuses(20, () => login({ email: EMAIL, password: "wrong" })), Array(20).fill(429));
  assert.equal((await login({ email: "other@example.test", password: "wrong" })).status, 401);
});

test("login: account-wide failures across addresses are capped; per-address failures are capped across accounts", async (t) => {
  const app = newApp(parseTrustProxy({ TRUST_PROXY: "loopback" }));
  app.use("/api", authPublic);
  const base = await serve(app, t);
  const from = (ip: string, body: object) => post(base + "/api/auth/login", body, { "x-forwarded-for": ip });

  // Ten addresses, five failures each: the account budget (50/hour) is spent.
  for (let a = 1; a <= 10; a++) {
    assert.deepEqual(await statuses(5, () => from(`192.0.2.${a}`, { email: EMAIL, password: "wrong" })), Array(5).fill(401));
  }
  assert.equal((await from("192.0.2.200", { email: EMAIL, password: "wrong" })).status, 429);
  assert.equal((await from("192.0.2.201", { email: "other@example.test", password: "wrong" })).status, 401);

  // One address spraying many accounts hits the per-address failure budget.
  const spray = await statuses(21, (i) => from("198.51.100.50", { email: `user${i}@example.test`, password: "wrong" }));
  assert.deepEqual(spray.slice(0, 20), Array(20).fill(401));
  assert.equal(spray[20], 429);
});

test("widget verification: per-address ceilings keep the established 429 body; existing service limits are untouched", async (t) => {
  const app = newApp();
  app.use("/api", widgetRouter);
  const base = await serve(app, t);
  const start = await statuses(21, () => post(base + "/api/widget/crm/verification/start", { phone: PHONE }));
  assert.deepEqual(start.slice(0, 20), Array(20).fill(400));
  const limited = await post(base + "/api/widget/crm/verification/start", { phone: PHONE });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.deepEqual(await limited.json(), {
    success: false,
    error: "rate_limited",
    message: "Too many verification requests. Please try again later.",
  });
  // Resend and factor attempts have independent budgets.
  assert.deepEqual(await statuses(20, () => post(base + "/api/widget/crm/verification/resend", {})), Array(20).fill(400));
  assert.equal((await post(base + "/api/widget/crm/verification/resend", {})).status, 429);
  const factor = await statuses(61, () => post(base + "/api/widget/crm/verification/verify", { code: CODE }));
  assert.deepEqual(factor.slice(0, 60), Array(60).fill(400));
  assert.equal(factor[60], 429);
  assert.equal(POLICIES.widgetVerificationStartIp.onStoreFailure, "closed");
});

test("widget tenant ceilings are keyed by the server-resolved widget owner, not by the caller", async (t) => {
  const app = newApp(parseTrustProxy({ TRUST_PROXY: "loopback" }));
  app.use("/api", widgetRouter);
  const base = await serve(app, t);
  const token = (apiKey: string, ip: string) => post(base + "/api/widget/voice-token", { apiKey, tenantId: 2, userId: 20 }, { "x-forwarded-for": ip });

  // Distinct visitors (one request each) share tenant A's 60/minute ceiling.
  const results = await statuses(61, (i) => token(WIDGET_KEY_A, `192.0.2.${i + 1}`));
  assert.deepEqual(results.slice(0, 60), Array(60).fill(403)); // voice disabled: passed the limiter
  assert.equal(results[60], 429);
  // Tenant B is unaffected even though tenant A's callers named tenant B in the body.
  assert.equal((await token(WIDGET_KEY_B, "192.0.2.200")).status, 403);
  // One visitor's per-address budget (10 / 10 min) applies before any tenant budget.
  assert.deepEqual(await statuses(11, () => token(WIDGET_KEY_B, "198.51.100.9")), [...Array(10).fill(403), 429]);
});

test("CRM: failed key authentication is limited per address; valid keys get independent per-key budgets", async (t) => {
  const app = newApp();
  app.use("/api", crmRouter);
  const base = await serve(app, t);
  const auth = (key: string) => ({ authorization: `Bearer ${key}` });

  // Requests with a valid key are refunded from the failed-auth budget.
  assert.deepEqual(await statuses(40, () => fetch(base + "/api/crm/campaigns/999/status", { headers: auth(CRM_KEY_B) })), Array(40).fill(404));
  const bad = await statuses(31, (i) => post(base + "/api/crm/campaigns/1/start", {}, auth("dk_live_" + String(i).padStart(64, "0"))));
  assert.deepEqual(bad.slice(0, 30), Array(30).fill(401));
  assert.equal(bad[30], 429);
});

test("CRM: billed operations have per-key budgets that body identifiers cannot redirect", async (t) => {
  const app = newApp();
  app.use("/api", crmRouter);
  const base = await serve(app, t);
  const startA = () => post(base + "/api/crm/campaigns/999/start", { tenantId: 2, userId: 20 }, { authorization: `Bearer ${CRM_KEY_A}` });
  assert.deepEqual(await statuses(11, startA), [...Array(10).fill(404), 429]);
  // Key B (tenant B) keeps its full budget.
  assert.equal((await post(base + "/api/crm/campaigns/999/start", {}, { authorization: `Bearer ${CRM_KEY_B}` })).status, 404);
  // Read-only CRM calls use the general per-key budget, not the launch budget.
  assert.equal((await fetch(base + "/api/crm/campaigns/999/status", { headers: { authorization: `Bearer ${CRM_KEY_A}` } })).status, 404);
});

test("campaign launch: per-principal budgets inside one tenant, plus a tenant ceiling", async (t) => {
  const app = newApp();
  // Stands in for resolveUser: identities are server-derived session values.
  app.use((req, _res, next) => {
    const [tenantUserId, tenantId, ownerId] = String(req.headers["x-test-principal"]).split(":").map(Number);
    Object.assign(req, { tenantUserId, tenantId, userId: ownerId });
    next();
  });
  app.use("/api", campaignsRouter);
  const base = await serve(app, t);
  const launch = (principal: string) => post(base + "/api/campaigns/999/start", {}, { "x-test-principal": principal });

  assert.deepEqual(await statuses(11, () => launch("100:1:10")), [...Array(10).fill(404), 429]);
  // Another member of the same tenant is not blocked by the first member's budget.
  assert.deepEqual(await statuses(10, () => launch("101:1:10")), Array(10).fill(404));
  assert.deepEqual(await statuses(10, () => launch("102:1:10")), Array(10).fill(404));
  // The tenant ceiling (30/minute) now applies to every member of tenant 1 ...
  assert.equal((await launch("103:1:10")).status, 429);
  // ... but not to tenant 2.
  assert.equal((await launch("200:2:20")).status, 404);
});

test("admin mutations are limited per principal; reads are not", async (t) => {
  const app = newApp();
  app.use((req, _res, next) => (Object.assign(req, { tenantUserId: 100, tenantId: 1 }), next()));
  app.use("/superadmin", adminMutationRateLimit);
  app.all("/superadmin/x", (_q, r) => r.json({ ok: true }));
  const base = await serve(app, t);
  assert.deepEqual(await statuses(130, () => fetch(base + "/superadmin/x")), Array(130).fill(200));
  const writes = await statuses(121, () => post(base + "/superadmin/x", {}));
  assert.deepEqual(writes.slice(0, 120), Array(120).fill(200));
  assert.equal(writes[120], 429);
});

test("signed Twilio callbacks are never rate limited and still finalize calls after other budgets are exhausted", async (t) => {
  const app = newApp();
  app.use("/api", twilioRouter);
  app.use("/api", crmRouter);
  const base = await serve(app, t);
  // Exhaust this address's CRM failed-auth budget first.
  const bad = await statuses(31, () => post(base + "/api/crm/calls", {}, { authorization: "Bearer dk_live_invalid" }));
  assert.equal(bad[30], 429);

  const path = "/api/twilio/status?callLogId=3";
  const body = { AccountSid: ACCOUNT_A, CallSid: CALL_C, CallStatus: "completed", CallDuration: "42", To: "+15550000009", From: "+15550000001" };
  const before = keys.length;
  const results = await statuses(40, () =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(TOKEN_A, "https://dialog.test" + path, body),
      },
      body: new URLSearchParams(body).toString(),
    }),
  );
  assert.deepEqual(results, Array(40).fill(200));
  assert.equal(keys.length, before, "provider callbacks never touch the rate-limit store");
  assert.equal(rows.call_logs[0].outcome, "answered");
  assert.equal(rows.call_logs[0].duration, 42);
});

test("limiter keys, logs and rejection bodies contain no credentials, contact details, codes or addresses", async (t) => {
  const app = newApp(parseTrustProxy({ TRUST_PROXY: "loopback" }));
  app.use("/api", authPublic);
  app.use("/api", widgetRouter);
  app.use("/api", crmRouter);
  const base = await serve(app, t);
  const ip = "203.0.113.77";
  const headers = { "x-forwarded-for": ip };
  const bodies: string[] = [];
  const capture = async (res: Response) => (bodies.push(JSON.stringify([...res.headers]) + (await res.text())), res.status);

  for (let i = 0; i < 6; i++) await capture(await post(base + "/api/auth/login", { email: EMAIL, password: PASSWORD + "x" }, headers));
  for (let i = 0; i < 61; i++)
    await capture(await post(base + "/api/widget/crm/verification/verify", { apiKey: WIDGET_KEY_A, code: CODE, phone: PHONE }, headers));
  for (let i = 0; i < 31; i++)
    await capture(await post(base + "/api/crm/calls", { phone: PHONE }, { ...headers, authorization: `Bearer ${CRM_KEY_A}x` }));
  assert.ok(bodies.filter((b) => b.includes("rate_limited")).length >= 3);

  const rejections = logs.filter((l) => l.event === "rate_limited");
  assert.ok(rejections.length >= 3);
  for (const entry of rejections) assert.deepEqual(Object.keys(entry).filter((k) => !["level", "time", "pid", "hostname", "msg"].includes(k)).sort(), ["event", "method", "policy"]);

  const haystack = [emitted(), ...bodies, ...keys].join("\n");
  for (const secret of [PASSWORD, EMAIL, PHONE, CODE, CRM_KEY_A, ip, WIDGET_KEY_A, "member@"]) {
    assert.ok(!haystack.toLowerCase().includes(secret.toLowerCase()), "leaked a sensitive value");
  }
  for (const key of keys) assert.match(key, /^[a-z_.]+:[A-Za-z0-9_-]{32}$/);
});

import "./postgres-rate-limit.test";
