import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import twilio from "twilio";
import WebSocket from "ws";
import { rows, resetDatabase } from "./fake-db";
import { emitted, resetLogs } from "./capture-logger";
import { safeErrorHandler } from "../src/lib/error-handler";
import { createHttpLogger } from "../src/lib/http-logger";
import { resolveUser, signToken } from "../src/middleware/auth";
import { resetRateLimitingForTests } from "../src/lib/rate-limit";
import { CorsConfigError, parseDashboardOrigins, surfaceFor } from "../src/lib/cors-policy";
import {
  API_CONTENT_SECURITY_POLICY,
  SecurityHeadersConfigError,
  htmlContentSecurityPolicy,
  installHttpSecurity,
  parseSecurityHeaderSettings,
} from "../src/lib/security-headers";
import { initWebSocketServer } from "../src/lib/crm-ws-server";
import authPublic from "../src/routes/auth-public";
import authRouter from "../src/routes/auth";
import twilioRouter from "../src/routes/twilio";
import widgetRouter from "../src/routes/widget";
import crmRouter from "../src/routes/crm";

after(() => {
  for (const timer of (globalThis as any).__dialogTestIntervals) clearInterval(timer);
});

// Synthetic values only.
const DASHBOARD = "https://dashboard.dialog.test";
const SHOP = "https://shop.customer.test";
const EVIL = "https://attacker.test";
const sid = (prefix: string, value: string) => prefix + value.repeat(32);
const ACCOUNT_A = sid("AC", "a");
const TOKEN_A = "fake-twilio-auth-token-tenant-a";
const CALL_C = sid("CA", "c");
const CRM_KEY_A = "dk_live_" + "a".repeat(64);
const WIDGET_KEY = "wk_fake_tenant_a_0001";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const SESSION = signToken({ tenantUserId: 100, jti: "e".repeat(64) });

beforeEach(() => {
  resetDatabase();
  resetLogs();
  resetRateLimitingForTests();
  rows.users = [{ id: 10 }];
  rows.tenants = [{ id: 1, ownerId: 10, status: "active", slug: "a", name: "Fake A", telephonyType: "TWILIO" }];
  rows.tenant_users = [{ id: 100, tenantId: 1, userId: 10, role: "admin", email: "member@example.test", isActive: true, name: "Fake member" }];
  rows.tenant_sessions = [
    { id: 1, token: "e".repeat(64), tenantUserId: 100, tenantId: 1, expiresAt: new Date(Date.now() + 60 * 60_000), revokedAt: null },
  ];
  rows.agent_configs = [
    { id: 1, userId: 10, agentName: "Fake agent", greeting: "Fake greeting", personality: "friendly", twilioAccountSid: ACCOUNT_A,
      twilioAuthToken: TOKEN_A, phoneNumber: "+15550000001", language: "en-US", aiModel: "gpt-4o-mini", voice: "nova",
      widgetApiKey: WIDGET_KEY, widgetEnabled: true, widgetExternalCrmEnabled: true, widgetVoiceEnabled: false },
  ];
  rows.external_crm_configs = [
    { id: 1, userId: 10, name: "Fake CRM", isEnabled: true, lookupUrl: "https://crm.customer.test/lookup", httpMethod: "GET",
      authType: "bearer", authValue: null, phoneParamName: "phone", phoneParamLocation: "query", responseMapping: null,
      useRawResponse: false, maxContextChars: 2000, timeoutMs: 3000, cacheTtlSeconds: 0, widgetChatSyncEnabled: false },
  ];
  rows.widget_verification_policies = [
    { id: 1, tenantId: 1, enabled: true, method: "order_suffix_4", dobFieldPath: null, dobFormat: null, version: 1 },
  ];
  rows.call_logs = [
    { id: 3, userId: 10, callSid: CALL_C, direction: "inbound", phone: "+15550000009", aiModel: "gpt-4o-mini",
      endedAt: null, startedAt: new Date(), liveTranscript: [] },
  ];
  rows.crm_api_keys = [{ id: 1, keyHash: hash(CRM_KEY_A), userId: 10, tenantId: 1, scopes: ["*"], isActive: true }];
});

/** Same middleware order as app.ts, with a temporary SPA build. */
async function harness(t: any, env: NodeJS.ProcessEnv = { DASHBOARD_ORIGINS: DASHBOARD }) {
  const publicDir = await mkdtemp(path.join(tmpdir(), "dialog-spa-"));
  t.after(() => rm(publicDir, { recursive: true, force: true }));
  await writeFile(path.join(publicDir, "index.html"), "<!doctype html><title>Fake SPA</title><div id=root></div>");
  await writeFile(path.join(publicDir, "app.js"), "console.log('fake asset');");

  const app = express();
  app.set("trust proxy", false);
  app.use(createHttpLogger());
  installHttpSecurity(app, env);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  // Stand-in for routes/health.ts (its generated schema package is not bundled for tests).
  app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));
  app.use("/api", authPublic);
  app.use("/api", twilioRouter);
  app.use("/api", widgetRouter);
  app.use("/api", crmRouter);
  app.get("/api/boom", () => {
    throw new Error("synthetic failure for fake-member@example.test");
  });
  app.use("/api", resolveUser);
  app.use("/api", authRouter);
  app.use(express.static(publicDir));
  app.use((_req, res) => {
    res.set("Cache-Control", "no-cache").sendFile(path.join(publicDir, "index.html"));
  });
  app.use(safeErrorHandler());

  const server: Server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { server, base: `http://127.0.0.1:${(server.address() as any).port}` };
}

const preflight = (url: string, origin: string, method: string, headers?: string) =>
  fetch(url, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      ...(headers ? { "access-control-request-headers": headers } : {}),
    },
  });

const cors = (res: Response) => ({
  origin: res.headers.get("access-control-allow-origin"),
  credentials: res.headers.get("access-control-allow-credentials"),
  methods: res.headers.get("access-control-allow-methods"),
  headers: res.headers.get("access-control-allow-headers"),
});

// ── Configuration ──────────────────────────────────────────────────────

test("dashboard origins must be exact https origins; invalid configuration fails without echoing values", () => {
  assert.deepEqual([...parseDashboardOrigins({})], []);
  assert.deepEqual([...parseDashboardOrigins({ DASHBOARD_ORIGINS: "none" })], []);
  assert.deepEqual(
    [...parseDashboardOrigins({ NODE_ENV: "production", DASHBOARD_ORIGINS: `${DASHBOARD}, https://admin.dialog.test:8443` })],
    [DASHBOARD, "https://admin.dialog.test:8443"],
  );
  assert.deepEqual([...parseDashboardOrigins({ DASHBOARD_ORIGINS: "http://localhost:5173" })], ["http://localhost:5173"]);
  const bad = [
    "*", "null", "https://*.dialog.test", `${DASHBOARD}/`, `${DASHBOARD}/app`, `${DASHBOARD}?x=1`, "https://user:pw@dialog.test",
    "HTTPS://DASHBOARD.DIALOG.TEST", "https://dashboard.dialog.test:443", "dashboard.dialog.test", "http://dashboard.dialog.test",
    "file:///etc/passwd", "javascript:alert(1)", `${DASHBOARD},`,
  ];
  for (const value of bad) {
    assert.throws(
      () => parseDashboardOrigins({ DASHBOARD_ORIGINS: value }),
      (err: Error) => err instanceof CorsConfigError && !err.message.includes(value.replace(/,$/, "") || "\u0000"),
      value,
    );
  }
  assert.throws(() => parseDashboardOrigins({ NODE_ENV: "production", DASHBOARD_ORIGINS: "http://localhost:5173" }), CorsConfigError);
});

test("HSTS is opt-in, production-only, https-only and strictly validated", () => {
  assert.equal(parseSecurityHeaderSettings({}).hstsMaxAge, null);
  assert.equal(parseSecurityHeaderSettings({ HSTS_MAX_AGE: "31536000" }).hstsMaxAge, null);
  assert.equal(
    parseSecurityHeaderSettings({ NODE_ENV: "production", HSTS_MAX_AGE: "31536000", PUBLIC_BASE_URL: "https://dialog.test" }).hstsMaxAge,
    31536000,
  );
  for (const value of ["-1", "1e9", "abc", "60", "999999999"])
    assert.throws(() => parseSecurityHeaderSettings({ HSTS_MAX_AGE: value }), SecurityHeadersConfigError, value);
  assert.throws(
    () => parseSecurityHeaderSettings({ NODE_ENV: "production", HSTS_MAX_AGE: "31536000", PUBLIC_BASE_URL: "http://dialog.test" }),
    SecurityHeadersConfigError,
  );
});

test("routes are classified by path only, matching Express's case-insensitive, trailing-slash routing", () => {
  const expected: Record<string, string> = {
    "/api/widget/chat": "widget",
    "/api/Widget/Chat/": "widget",
    "/api/widget/config/abc": "widget",
    "/api/widget/loader.js": "widget",
    "/api/widget/tts": "widget",
    "/api/widget/voice-token": "widget",
    "/api/widget/crm/verification/start": "widget",
    "/api/widget/crm/select-order": "widget",
    "/api/widget/generate-key": "dashboard",
    "/api/widget/generate-key/": "dashboard",
    "/api/widget-verification/policy": "dashboard",
    "/api/crm-admin/api-keys": "dashboard",
    "/api/crm-agents": "dashboard",
    "/api/auth/login": "dashboard",
    "/api/crm/calls": "server",
    "/api/CRM/calls/1/transfer": "server",
    "/api/twilio/status": "server",
    "/api/exotel/connect": "server",
    "/api/healthz": "server",
    "/": "html",
    "/assets/index.js": "html",
    "/apiary": "html",
  };
  for (const [p, surface] of Object.entries(expected)) assert.equal(surfaceFor(p), surface, p);
});

// ── Dashboard CORS ─────────────────────────────────────────────────────

test("configured dashboard origins get exact, non-credentialed CORS on success and error responses", async (t) => {
  const { base } = await harness(t);
  const me = await fetch(base + "/api/auth/me", { headers: { origin: DASHBOARD, authorization: `Bearer ${SESSION}` } });
  assert.equal(me.status, 200);
  assert.deepEqual(cors(me), { origin: DASHBOARD, credentials: null, methods: null, headers: null });
  assert.match(me.headers.get("vary") ?? "", /Origin/);
  assert.equal(me.headers.get("access-control-expose-headers"), "Retry-After");

  const denied = await fetch(base + "/api/auth/me", { headers: { origin: DASHBOARD } });
  assert.equal(denied.status, 401);
  assert.equal(cors(denied).origin, DASHBOARD);

  const pre = await preflight(base + "/api/auth/profile/password", DASHBOARD, "PUT", "Authorization, Content-Type");
  assert.equal(pre.status, 204);
  assert.deepEqual(cors(pre), {
    origin: DASHBOARD,
    credentials: null,
    methods: "GET, POST, PUT, PATCH, DELETE",
    headers: "authorization, content-type",
  });
  assert.equal(pre.headers.get("access-control-max-age"), "600");
  assert.match(pre.headers.get("vary") ?? "", /Origin.*Access-Control-Request-Method.*Access-Control-Request-Headers/);
});

test("unknown, malformed, null and look-alike origins never receive dashboard CORS", async (t) => {
  const { base } = await harness(t);
  const origins = [
    EVIL, "null", `${DASHBOARD}.attacker.test`, `${DASHBOARD}/`, DASHBOARD.toUpperCase(), `${DASHBOARD}:443`,
    "http://dashboard.dialog.test", `${DASHBOARD}, ${EVIL}`, `${EVIL}, ${DASHBOARD}`, "",
  ];
  for (const origin of origins) {
    const res = await fetch(base + "/api/auth/me", { headers: { origin, authorization: `Bearer ${SESSION}` } });
    // CORS is not authentication: the server still answers a bearer-authenticated
    // request, but the browser is never told it may expose the response.
    assert.equal(res.status, 200);
    assert.deepEqual(cors(res), { origin: null, credentials: null, methods: null, headers: null }, origin);
    const pre = await preflight(base + "/api/auth/me", origin || "null", "GET", "authorization");
    assert.equal(pre.status, 403, origin);
    assert.equal(cors(pre).origin, null);
  }
});

test("same-origin deployment (no DASHBOARD_ORIGINS) grants no cross-origin dashboard access", async (t) => {
  const { base } = await harness(t, {});
  for (const origin of [DASHBOARD, base, EVIL]) {
    const res = await fetch(base + "/api/auth/me", { headers: { origin, authorization: `Bearer ${SESSION}` } });
    assert.equal(res.status, 200);
    assert.equal(cors(res).origin, null);
    assert.equal((await preflight(base + "/api/auth/me", origin, "GET", "authorization")).status, 403);
  }
  // Same-origin browser requests need no CORS headers and keep working.
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ email: "member@example.test", password: "wrong" }),
  });
  assert.equal(login.status, 401);
});

test("forwarding and host headers cannot change the trusted-origin decision", async (t) => {
  const { base } = await harness(t);
  const spoof = {
    host: "dashboard.dialog.test",
    "x-forwarded-host": "dashboard.dialog.test",
    "x-forwarded-proto": "https",
    forwarded: "host=dashboard.dialog.test;proto=https",
    referer: DASHBOARD + "/",
    "x-original-origin": DASHBOARD,
  };
  const res = await fetch(base + "/api/auth/me", { headers: { ...spoof, origin: EVIL, authorization: `Bearer ${SESSION}` } });
  assert.equal(cors(res).origin, null);
  const pre = await fetch(base + "/api/auth/me", {
    method: "OPTIONS",
    headers: { ...spoof, origin: EVIL, "access-control-request-method": "GET" },
  });
  assert.equal(pre.status, 403);
  assert.equal(cors(pre).origin, null);
});

test("preflights reject methods and headers outside each surface's allowlist", async (t) => {
  const { base } = await harness(t);
  for (const method of ["TRACE", "CONNECT", "PROPFIND", "get"])
    assert.equal((await preflight(base + "/api/auth/me", DASHBOARD, method)).status, 403, method);
  for (const headers of ["x-custom", "authorization, x-forwarded-for", "cookie"])
    assert.equal((await preflight(base + "/api/auth/me", DASHBOARD, "GET", headers)).status, 403, headers);
  for (const method of ["PUT", "DELETE", "PATCH"])
    assert.equal((await preflight(base + "/api/widget/chat", SHOP, method, "content-type")).status, 403, method);
  assert.equal((await preflight(base + "/api/widget/chat", SHOP, "POST", "content-type, authorization")).status, 403);
  // Server-to-server and static surfaces have no browser grant at all.
  for (const p of ["/api/crm/calls", "/api/twilio/status", "/api/healthz", "/", "/app.js"])
    assert.equal((await preflight(base + p, DASHBOARD, "POST", "content-type")).status, 403, p);
});

test("no response ever pairs a wildcard (or any) origin with credentials; wildcards are widget-only", async (t) => {
  const { base } = await harness(t);
  const paths = [
    "/api/healthz", "/api/auth/me", "/api/widget/config/" + WIDGET_KEY, "/api/widget/loader.js?key=" + WIDGET_KEY,
    "/api/crm/agents", "/api/twilio/status", "/", "/app.js", "/api/does-not-exist", "/api/boom",
  ];
  for (const p of paths) {
    for (const origin of [DASHBOARD, SHOP, EVIL, "null"]) {
      for (const res of [
        await fetch(base + p, { headers: { origin } }),
        await preflight(base + p, origin, "GET"),
      ]) {
        await res.arrayBuffer();
        assert.equal(res.headers.get("access-control-allow-credentials"), null, p);
        if (res.headers.get("access-control-allow-origin") === "*") assert.equal(surfaceFor(p.split("?")[0]), "widget", p);
      }
    }
  }
});

// ── Public widget ──────────────────────────────────────────────────────

test("the public widget stays embeddable from any site without credentials", async (t) => {
  const { base } = await harness(t);
  const loader = await fetch(base + "/api/widget/loader.js?key=" + WIDGET_KEY, { headers: { origin: SHOP } });
  assert.equal(loader.status, 200);
  assert.match(loader.headers.get("content-type") ?? "", /javascript/);
  assert.equal(cors(loader).origin, "*");
  assert.equal(loader.headers.get("x-content-type-options"), "nosniff");
  // No document CSP on the script: it executes under the embedding page's policy.
  assert.equal(loader.headers.get("content-security-policy"), API_CONTENT_SECURITY_POLICY);
  assert.match(await loader.text(), /\/api\/widget\/chat/);

  const config = await fetch(base + "/api/widget/config/" + WIDGET_KEY, { headers: { origin: SHOP } });
  assert.equal(config.status, 200);
  assert.equal(cors(config).origin, "*");

  for (const p of ["/api/widget/chat", "/api/widget/tts", "/api/widget/voice-token", "/api/widget/crm/verification/start",
    "/api/widget/crm/verification/verify", "/api/widget/crm/select-order", "/api/widget/crm/session/end"]) {
    const pre = await preflight(base + p, SHOP, "POST", "content-type");
    assert.equal(pre.status, 204, p);
    assert.deepEqual(cors(pre), { origin: "*", credentials: null, methods: "GET, POST", headers: "content-type" });
  }
  // Errors keep CORS so the embed can read them.
  const missing = await fetch(base + "/api/widget/chat", {
    method: "POST",
    headers: { origin: SHOP, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "unknown-widget-key", message: "hi" }),
  });
  assert.equal(missing.status, 404);
  assert.equal(cors(missing).origin, "*");
  // Widget key generation is a dashboard action, not a public widget route.
  const pre = await preflight(base + "/api/widget/generate-key", SHOP, "POST", "content-type");
  assert.equal(pre.status, 403);
});

test("customer verification and order access are enforced server-side whatever the Origin", async (t) => {
  const { base } = await harness(t);
  for (const origin of [undefined, SHOP, DASHBOARD, EVIL, "null"]) {
    const headers: Record<string, string> = { "content-type": "application/json", ...(origin ? { origin } : {}) };
    const post = (p: string, body: object) => fetch(base + p, { method: "POST", headers, body: JSON.stringify(body) });

    const select = await post("/api/widget/crm/select-order", { apiKey: WIDGET_KEY, orderId: "ORD-1" });
    assert.equal(select.status, 401, String(origin));
    assert.equal((await select.json()).error, "verification_required");
    const forged = await post("/api/widget/crm/select-order", { apiKey: WIDGET_KEY, sessionToken: "forged", orderId: "ORD-1" });
    assert.equal(forged.status, 401);
    const verify = await post("/api/widget/crm/verification/verify", {
      apiKey: WIDGET_KEY, challengeId: "00000000-0000-4000-8000-000000000000", orderDigits: "1234",
    });
    assert.equal(verify.status, 400);
    // A dashboard bearer token is not a customer session either.
    const withDashboardToken = await fetch(base + "/api/widget/crm/select-order", {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${SESSION}` },
      body: JSON.stringify({ apiKey: WIDGET_KEY, orderId: "ORD-1" }),
    });
    assert.equal(withDashboardToken.status, 401);
  }
});

// ── Server-to-server ───────────────────────────────────────────────────

test("CRM API-key routes behave as before and never grant browser access", async (t) => {
  const { base } = await harness(t);
  const noKey = await fetch(base + "/api/crm/agents", { headers: { origin: EVIL } });
  assert.equal(noKey.status, 401);
  assert.equal(cors(noKey).origin, null);
  const ok = await fetch(base + "/api/crm/agents", { headers: { origin: DASHBOARD, authorization: `Bearer ${CRM_KEY_A}` } });
  assert.equal(ok.status, 200);
  assert.equal(cors(ok).origin, null);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const serverToServer = await fetch(base + "/api/crm/agents", { headers: { authorization: `Bearer ${CRM_KEY_A}` } });
  assert.equal(serverToServer.status, 200);
});

test("signed Twilio callbacks are accepted with or without Origin; unsigned ones are still refused", async (t) => {
  const { base } = await harness(t);
  const p = "/api/twilio/status?callLogId=3";
  const body = { AccountSid: ACCOUNT_A, CallSid: CALL_C, CallStatus: "completed", CallDuration: "42", To: "+15550000009", From: "+15550000001" };
  const signature = twilio.getExpectedTwilioSignature(TOKEN_A, "https://dialog.test" + p, body);
  const send = (headers: Record<string, string>) =>
    fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(body).toString(),
    });
  assert.equal((await send({ origin: EVIL })).status, 403);
  const signed = await send({ "x-twilio-signature": signature, origin: EVIL });
  assert.equal(signed.status, 200);
  assert.equal(cors(signed).origin, null);
  assert.equal((await send({ "x-twilio-signature": signature })).status, 200);
  assert.equal(rows.call_logs[0].outcome, "answered");
});

test("WebSocket upgrades bypass the HTTP CORS layer and keep their own authentication", async (t) => {
  const { server, base } = await harness(t);
  const dispose = initWebSocketServer(server);
  t.after(dispose);
  const url = base.replace("http", "ws") + "/ws/crm/calls";
  const ws = new WebSocket(`${url}?apiKey=${CRM_KEY_A}`, { headers: { origin: EVIL } });
  t.after(() => ws.terminate());
  await once(ws, "open");
  const status = await new Promise<number>((resolve) => {
    const bad = new WebSocket(`${url}?apiKey=dk_live_${"0".repeat(64)}`, { headers: { origin: DASHBOARD } });
    bad.on("unexpected-response", (_req, res) => (res.resume(), bad.terminate(), resolve(res.statusCode!)));
    bad.on("error", () => {});
  });
  assert.equal(status, 401);
});

// ── Security headers ───────────────────────────────────────────────────

test("HTML and static responses carry the document policy; API responses the data policy", async (t) => {
  const { base } = await harness(t, { NODE_ENV: "production", DASHBOARD_ORIGINS: DASHBOARD, HSTS_MAX_AGE: "31536000", PUBLIC_BASE_URL: "https://dialog.test" });
  for (const p of ["/", "/dashboard/settings", "/app.js"]) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get("content-security-policy"), htmlContentSecurityPolicy(true));
    assert.match(res.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "same-origin");
    assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.match(res.headers.get("permissions-policy") ?? "", /camera=\(\)/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000");
    assert.equal(res.headers.get("x-powered-by"), null);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  }
  assert.equal((await fetch(base + "/dashboard/settings")).headers.get("cache-control"), "no-cache");

  const api = [
    ["/api/healthz", 200],
    ["/api/auth/me", 401],
    ["/api/boom", 500],
    ["/api/widget/config/unknown", 404],
  ] as const;
  for (const [p, status] of api) {
    const res = await fetch(base + p);
    assert.equal(res.status, status, p);
    assert.equal(res.headers.get("content-security-policy"), API_CONTENT_SECURITY_POLICY, p);
    assert.equal(res.headers.get("cache-control"), "no-store", p);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer", p);
    assert.equal(res.headers.get("x-frame-options"), "DENY", p);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", p);
    assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000", p);
    assert.equal(res.headers.get("x-powered-by"), null, p);
  }
  // Body-parser failures happen before routing and still carry the headers.
  const malformed = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: DASHBOARD },
    body: "{not json",
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("cache-control"), "no-store");
  assert.equal(cors(malformed).origin, DASHBOARD);
  assert.equal(await malformed.text(), "Bad Request");
  // Preflight responses carry them too.
  const pre = await preflight(base + "/api/auth/me", DASHBOARD, "GET");
  assert.equal(pre.headers.get("x-content-type-options"), "nosniff");
});

test("outside production, framing is left to the development preview and HSTS is off", async (t) => {
  const { base } = await harness(t, { HSTS_MAX_AGE: "31536000" });
  const res = await fetch(base + "/");
  assert.doesNotMatch(res.headers.get("content-security-policy")!, /frame-ancestors/);
  assert.equal(res.headers.get("x-frame-options"), null);
  assert.equal(res.headers.get("strict-transport-security"), null);
});

test("the document CSP admits every asset the built frontend and widget loader actually use", async (t) => {
  const csp = htmlContentSecurityPolicy(true);
  const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(name + " "))!.split(" ").slice(1);
  const allows = (name: string, url: string) => {
    const { protocol, host } = new URL(url);
    return directive(name).some((source) =>
      source === `${protocol}//${host}` || (source.includes("*.") && protocol === source.split("//")[0] && host.endsWith(source.split("*")[1])),
    );
  };
  assert.doesNotMatch(csp, /'unsafe-eval'|script-src[^;]*'unsafe-inline'|script-src[^;]*\*/);

  const root = path.resolve("../sales-sutra");
  const pages = [path.join(root, "index.html"), path.join(root, "public/test/index.html"), path.join(root, "dist/public/index.html"), path.join(root, "dist/public/test/index.html")].filter(existsSync);
  assert.ok(pages.length >= 2);
  for (const page of pages) {
    // Example embed snippets shown in form placeholders are text, not markup.
    const html = (await readFile(page, "utf8")).replace(/placeholder='[^']*'/g, "");
    for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      assert.match(attrs, /\bsrc=/, `${page}: inline scripts are blocked by the CSP`);
      assert.equal(body.trim(), "");
    }
    for (const [, url] of html.matchAll(/<script[^>]*\ssrc="(https?:\/\/[^"]+)"/g)) assert.ok(allows("script-src", url), url);
    for (const [, url] of html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="(https?:\/\/[^"]+)"/g)) assert.ok(allows("style-src", url), url);
  }

  const { base } = await harness(t);
  const loader = await (await fetch(base + "/api/widget/loader.js?key=" + WIDGET_KEY)).text();
  for (const [, url] of loader.matchAll(/\.src\s*=\s*'(https:\/\/[^']+)'/g)) assert.ok(allows("script-src", url), url);
  assert.ok(allows("connect-src", "wss://chunderw-vpc-gll.twilio.com/signal"));
  assert.ok(allows("connect-src", "https://eventgw.twilio.com/v1/EndpointEvents"));
  assert.ok(directive("media-src").includes("data:"), "loader plays data: audio");
  assert.ok(allows("media-src", "https://cdn.openai.com/API/docs/audio/nova.wav"));
  assert.ok(allows("font-src", "https://fonts.gstatic.com/s/inter/v1/x.woff2"));
});

test("app.ts installs headers and CORS before body parsing and routing, without the old wildcard cors()", async () => {
  const source = await readFile(path.resolve("src/app.ts"), "utf8");
  const installed = source.indexOf("installHttpSecurity(app, process.env)");
  assert.ok(installed > 0);
  assert.ok(installed < source.indexOf("app.use(express.json())"));
  assert.ok(installed < source.indexOf('app.use("/api", healthRouter)'));
  assert.doesNotMatch(source, /from "cors"|app\.use\(cors\(/);
});

test("headers and CORS decisions add no request data to logs", async (t) => {
  const { base } = await harness(t);
  await fetch(base + "/api/auth/me", { headers: { origin: EVIL + "/fake-origin-marker", authorization: `Bearer ${SESSION}` } });
  await preflight(base + "/api/auth/me", "https://fake-preflight-marker.test", "DELETE", "x-fake-header-marker");
  const output = emitted();
  for (const marker of [SESSION, "fake-origin-marker", "fake-preflight-marker", "x-fake-header-marker"])
    assert.ok(!output.includes(marker), marker);
});
