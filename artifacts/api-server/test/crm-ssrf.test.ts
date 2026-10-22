// Phase 1F: tenant-configured CRM destinations cannot reach internal networks.
// Every destination is either rejected before any socket is opened or is the
// local HTTPS fixture; DNS is a fake table and the CA is test-only.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { Server as HttpsServer } from "node:https";
import express from "express";
import { rows, resetDatabase } from "./fake-db";
import { logs, emitted, resetLogs } from "./capture-logger";
import {
  allowFixture,
  crmDnsQueries,
  crmTestCa,
  crmTestDns,
  CRM_TEST_HOST,
  CRM_TEST_OTHER_HOST,
  fakeResolve,
  listenCrmFixture,
  resetCrmTestDns,
} from "./fake-crm-http";
import {
  clampTimeout,
  createSafeHttpClient,
  describeOutboundError,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  isPublicAddress,
  OutboundRequestError,
  type OutboundResolver,
} from "../src/lib/safe-outbound-http";
import {
  fetchExternalCrmData,
  invalidateExternalCrmConfigCache,
  testExternalCrmLookup,
} from "../src/lib/external-crm-lookup";
import { recordWidgetChatTurn } from "../src/lib/widget-crm-chat-sync";
import { startWebhookDispatcher } from "../src/lib/webhook-dispatcher";
import { crmEventBus } from "../src/lib/crm-event-bus";
import externalCrmRouter from "../src/routes/external-crm";
import crmRouter from "../src/routes/crm";

const PHONE = "+15550100777";
const PHONE_DIGITS = "5550100777";
const ORDER_ID = "ORD-SYNTH-4242";
const CUSTOMER = "Synthetic Customer Name";
const CRM_SECRET = "fake-crm-bearer-secret-value";
const QUERY_SECRET = "fake-query-secret-value";
const CRM_KEY = "dk_live_" + "e".repeat(64);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

// ── Outbound connection and DNS instrumentation ────────────────────────
// The production client calls https.request on the module object, so this
// wrapper sees every socket it would open. Only the loopback fixture is ever
// passed through; anything else would be a test failure, not a real request.
const httpsModule = require("node:https");
const dnsModule = require("node:dns");
type Attempt = { host: string; servername?: string; port: number; headers: Record<string, string> };
const attempts: Attempt[] = [];
const realRequest = httpsModule.request;
httpsModule.request = function (options: any, ...rest: any[]) {
  attempts.push({ host: options.host, servername: options.servername, port: options.port, headers: { ...options.headers } });
  if (options.host !== "127.0.0.1") throw new Error("test: connection to a non-fixture address attempted");
  return realRequest.call(this, options, ...rest);
};
const systemLookups: string[] = [];
const realLookup = dnsModule.lookup;
dnsModule.lookup = function (hostname: string, ...rest: any[]) {
  systemLookups.push(hostname);
  return realLookup.call(this, hostname, ...rest);
};
after(() => {
  httpsModule.request = realRequest;
  dnsModule.lookup = realLookup;
  for (const timer of (globalThis as any).__dialogTestIntervals) clearInterval(timer);
});

// ── HTTPS fixture ──────────────────────────────────────────────────────
type Hit = { path: string; host?: string; authorization?: string; transferEncoding?: string; body: string };
const hits: Hit[] = [];
let connections = 0;
let fixture: HttpsServer;
let port = 0;
let base = "";
before(async () => {
  ({ server: fixture, port, base } = await listenCrmFixture((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "https://fixture.invalid");
      hits.push({
        path: url.pathname,
        host: req.headers.host,
        authorization: req.headers.authorization,
        transferEncoding: req.headers["transfer-encoding"] as string | undefined,
        body,
      });
      switch (url.pathname) {
        case "/redirect-metadata":
          res.writeHead(302, { Location: "https://169.254.169.254/latest/meta-data/iam/" }).end();
          return;
        case "/redirect-self":
          res.writeHead(301, { Location: "/redirect-self" }).end();
          return;
        case "/redirect-same-host":
          res.writeHead(307, { Location: `https://${CRM_TEST_HOST}:${port}/ok` }).end();
          return;
        case "/hang":
          return;
        case "/drip": {
          res.writeHead(200, { "Content-Type": "application/json" });
          const timer = setInterval(() => res.write(" "), 50);
          res.on("close", () => clearInterval(timer));
          return;
        }
        case "/big-declared":
          res.writeHead(200, { "Content-Length": "5000" }).end("x".repeat(5000));
          return;
        case "/big-chunked":
          res.writeHead(200);
          for (let i = 0; i < 20; i++) res.write("y".repeat(1024));
          res.end();
          return;
        case "/tenant-a/lookup":
        case "/tenant-b/lookup": {
          const tenant = url.pathname.split("/")[1];
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({ found: true, customer: { name: `${CUSTOMER} ${tenant}` }, orders: [{ orderId: ORDER_ID }] }),
          );
          return;
        }
        default:
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      }
    });
  }));
  fixture.on("connection", () => connections++);
});
after(() => {
  fixture.closeAllConnections();
  fixture.close();
});

beforeEach(() => {
  resetDatabase();
  resetLogs();
  resetCrmTestDns();
  attempts.length = 0;
  systemLookups.length = 0;
  hits.length = 0;
  connections = 0;
});

const testClient = (resolve: OutboundResolver = fakeResolve) =>
  createSafeHttpClient({ resolve, isAllowedAddress: allowFixture, ca: crmTestCa });

async function rejection(promise: Promise<unknown>): Promise<OutboundRequestError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof OutboundRequestError, `unexpected error ${String(err)}`);
    return err;
  }
  assert.fail("expected the request to be rejected");
}

function assertNoLeak(values: string[]) {
  const out = emitted();
  for (const value of values) assert.ok(!out.includes(value), `log output leaked: ${value}`);
}

// ── Address classification ─────────────────────────────────────────────

test("address policy accepts public unicast and rejects every non-public range", () => {
  for (const address of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:93.184.216.34"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of [
    "127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "169.254.170.2", "100.64.0.1", "100.100.100.200", "0.0.0.0", "255.255.255.255",
    "224.0.0.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "240.0.0.1",
    "::", "::1", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "64:ff9b::a9fe:a9fe",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:10.0.0.1", "::127.0.0.1",
    "2001:db8::1", "2002:a9fe:a9fe::1", "2001::1", "fe80::1%eth0", "not-an-ip", "",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

// ── URL policy (no DNS, no socket) ─────────────────────────────────────

test("URL policy: only public HTTPS URLs without credentials or unsafe ports pass, before any I/O", async () => {
  let resolves = 0;
  // Production address policy: no fixture exemption.
  const client = createSafeHttpClient({
    resolve: async (host) => {
      resolves++;
      return fakeResolve(host);
    },
  });
  for (const url of [
    "https://crm.example.com/lookup?phone=1",
    "https://crm.example.com:8443/lookup",
    "https://crm.example.com:443/lookup",
    "https://93.184.216.34/lookup",
    "https://[2606:4700:4700::1111]/lookup",
  ]) {
    assert.equal(client.assertUrl(url).protocol, "https:", url);
  }
  const cases: Array<[string, string]> = [
    ["http://crm.example.com/lookup", "scheme"],
    ["ftp://crm.example.com/file", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["gopher://127.0.0.1:6379/_INFO", "scheme"],
    ["ws://crm.example.com/socket", "scheme"],
    ["https://user:pass@crm.example.com/lookup", "credentials"],
    ["https://token@crm.example.com/lookup", "credentials"],
    ["https://crm.example.com:22/", "port"],
    ["https://crm.example.com:80/", "port"],
    ["https://crm.example.com:0/", "port"],
    ["https://crm.example.com:99999/", "invalid_url"],
    ["not a url", "invalid_url"],
    ["", "invalid_url"],
    ["https://", "invalid_url"],
    [`https://crm.example.com/${"a".repeat(3000)}`, "invalid_url"],
    ["https://localhost/lookup", "hostname"],
    ["https://LOCALHOST./lookup", "hostname"],
    ["https://api.localhost/lookup", "hostname"],
    ["https://intranet/lookup", "hostname"],
    ["https://crm.example.com{phone}.evil/", "hostname"],
    ["https://127.0.0.1/lookup", "address"],
    ["https://2130706433/lookup", "address"],
    ["https://0x7f.1/lookup", "address"],
    ["https://0177.0.0.1/lookup", "address"],
    ["https://127.1/lookup", "address"],
    ["https://0/lookup", "address"],
    ["https://10.0.0.5/lookup", "address"],
    ["https://169.254.169.254/latest/meta-data/", "address"],
    ["https://[::1]/lookup", "address"],
    ["https://[::ffff:127.0.0.1]/lookup", "address"],
    ["https://[::ffff:a9fe:a9fe]/latest/meta-data/", "address"],
    ["https://[fd00:ec2::254]/latest/meta-data/", "address"],
    ["https://[fe80::1]/lookup", "address"],
  ];
  for (const [url, reason] of cases) {
    assert.throws(() => client.assertUrl(url), (err: any) => err.reason === reason, `${url} -> ${reason}`);
    const err = await rejection(client.request(url));
    assert.equal(err.reason, reason, url);
    assert.equal(err.blocked, true);
    assert.ok(!/https?:|127|169\.254|::1|example/.test(err.message), `error message leaks the destination: ${err.message}`);
  }
  assert.equal(resolves, 0, "rejected URLs must not reach DNS");
  assert.equal(attempts.length, 0, "rejected URLs must not open a connection");
  assert.equal((await rejection(client.request(`https://127.0.0.1:${port}/ok`))).reason, "address");
  assert.equal(connections, 0);
});

// ── DNS validation ─────────────────────────────────────────────────────

test("DNS failures, empty, non-public and mixed answers fail closed before connecting", async () => {
  const cases: Array<[string[] | Error, string]> = [
    [new Error("ENOTFOUND"), "dns"],
    [[], "dns"],
    [["10.0.0.5"], "address"],
    [["169.254.169.254"], "address"],
    [["::1"], "address"],
    [["fd00::5"], "address"],
    [["::ffff:169.254.169.254"], "address"],
    [["93.184.216.34", "10.0.0.5"], "address"],
    [["10.0.0.5", "93.184.216.34"], "address"],
    [["2606:4700:4700::1111", "fe80::1"], "address"],
  ];
  for (const [answer, reason] of cases) {
    const client = testClient(async () => {
      if (answer instanceof Error) throw answer;
      return answer.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    });
    const err = await rejection(client.request("https://crm.example.com/lookup"));
    assert.equal(err.reason, reason, JSON.stringify(answer instanceof Error ? "error" : answer));
  }
  // The strict default policy rejects the fixture address too.
  const strict = createSafeHttpClient({ resolve: fakeResolve, ca: crmTestCa });
  assert.equal((await rejection(strict.request(`${base}/ok`))).reason, "address");
  assert.equal(attempts.length, 0);
  assert.equal(connections, 0);
});

test("a public answer is connected by IP with TLS SNI and Host set to the configured hostname", async () => {
  const client = createSafeHttpClient({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  // The instrumentation refuses non-fixture sockets, so this public address is
  // recorded but never contacted.
  const err = await rejection(client.request("https://crm.example.com:8443/lookup?x=1"));
  assert.equal(err.reason, "network");
  assert.equal(attempts.length, 1);
  assert.deepEqual(
    { host: attempts[0].host, servername: attempts[0].servername, port: attempts[0].port, hostHeader: attempts[0].headers.host },
    { host: "93.184.216.34", servername: "crm.example.com", port: 8443, hostHeader: "crm.example.com:8443" },
  );
  // IPv4-mapped public answers connect over IPv4 to the embedded address.
  const mapped = createSafeHttpClient({ resolve: async () => [{ address: "::ffff:93.184.216.34", family: 6 }] });
  await rejection(mapped.request("https://crm.example.com/lookup"));
  assert.equal(attempts[1].host, "93.184.216.34");
  assert.equal(systemLookups.length, 0, "no system DNS lookup may happen at connect time");
});

// ── Pinning, DNS rebinding and TLS identity ────────────────────────────

test("legitimate HTTPS request succeeds against the pinned address with hostname-verified TLS", async () => {
  const client = testClient();
  const response = await client.request(`${base}/ok?k=v`, {
    method: "POST",
    headers: { Authorization: "Bearer x", Host: "169.254.169.254", "Transfer-Encoding": "chunked", Connection: "keep-alive" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), { ok: true });
  assert.equal(hits[0].host, `${CRM_TEST_HOST}:${port}`, "caller-supplied Host is ignored");
  assert.equal(hits[0].transferEncoding, undefined);
  assert.equal(hits[0].authorization, "Bearer x");
  assert.equal(attempts[0].host, "127.0.0.1");
  assert.equal(attempts[0].servername, CRM_TEST_HOST);
  assert.deepEqual(crmDnsQueries, [CRM_TEST_HOST]);
  assert.equal(systemLookups.length, 0);
  // A second hostname on the same certificate also verifies.
  assert.equal((await client.request(`https://${CRM_TEST_OTHER_HOST}:${port}/ok`)).status, 200);
});

test("DNS rebinding cannot redirect the connection: one resolution per request, and it is the one used", async () => {
  // First answer is the fixture; every later answer is cloud metadata.
  let calls = 0;
  const rebinding: OutboundResolver = async () =>
    calls++ === 0 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "169.254.169.254", family: 4 }];
  const client = testClient(rebinding);
  assert.equal((await client.request(`${base}/ok`)).status, 200);
  assert.equal(calls, 1, "the hostname is resolved exactly once per request");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].host, "127.0.0.1", "the socket targets the validated address literal");
  assert.equal(systemLookups.length, 0, "the HTTP stack performs no second lookup");
  // The next request re-resolves, sees the rebinding answer, and never connects.
  assert.equal((await rejection(client.request(`${base}/ok`))).reason, "address");
  assert.equal(attempts.length, 1);
  assert.equal(hits.length, 1);

  // Reverse order: a first non-public answer is rejected before connecting
  // even if a later answer would be acceptable.
  calls = 0;
  const reverse = testClient(async () =>
    calls++ === 0 ? [{ address: "10.0.0.5", family: 4 }] : [{ address: "127.0.0.1", family: 4 }],
  );
  assert.equal((await rejection(reverse.request(`${base}/ok`))).reason, "address");
  assert.equal(attempts.length, 1);
});

test("TLS still verifies the configured hostname and trust chain while connecting by IP", async () => {
  crmTestDns.set("mismatch.dialog.test", ["127.0.0.1"]);
  const client = testClient();
  const mismatch = await rejection(client.request(`https://mismatch.dialog.test:${port}/ok`));
  assert.equal(mismatch.reason, "tls");
  // Production trust store only: the fake test CA is not trusted.
  const untrusted = await rejection(
    createSafeHttpClient({ resolve: fakeResolve, isAllowedAddress: allowFixture }).request(`${base}/ok`),
  );
  assert.equal(untrusted.reason, "tls");
  assert.equal(hits.length, 0, "no HTTP request is sent over an unverified connection");
});

// ── Redirects ──────────────────────────────────────────────────────────

test("redirects are never followed, including to metadata, loops and the same host", async () => {
  const client = testClient();
  for (const path of ["/redirect-metadata", "/redirect-self", "/redirect-same-host"]) {
    const before = attempts.length;
    const err = await rejection(client.request(`${base}${path}`));
    assert.equal(err.reason, "redirect", path);
    assert.equal(attempts.length - before, 1, `${path} made exactly one request`);
  }
  assert.deepEqual(hits.map((h) => h.path), ["/redirect-metadata", "/redirect-self", "/redirect-same-host"]);
  assert.ok(attempts.every((a) => a.host === "127.0.0.1"));
});

// ── Timeouts and size limits ───────────────────────────────────────────

test("slow DNS, slow responses and slow bodies hit the overall deadline", async () => {
  const stalled = testClient(() => new Promise(() => {}));
  let started = Date.now();
  assert.equal((await rejection(stalled.request(`${base}/ok`, { timeoutMs: 300 }))).reason, "timeout");
  assert.ok(Date.now() - started < 2000);
  assert.equal(attempts.length, 0);

  const client = testClient();
  for (const path of ["/hang", "/drip"]) {
    started = Date.now();
    assert.equal((await rejection(client.request(`${base}${path}`, { timeoutMs: 300 }))).reason, "timeout", path);
    assert.ok(Date.now() - started < 2000, `${path} deadline enforced`);
  }
  // Tenant timeouts are clamped (the request deadline is clampTimeout(timeoutMs)):
  // an absurdly small value is raised to the floor, a huge one capped. Asserted
  // directly; a live request against a 250 ms floor is timing-dependent under load.
  assert.equal(clampTimeout(1), MIN_TIMEOUT_MS);
  assert.equal(clampTimeout(10 ** 9), MAX_TIMEOUT_MS);
  assert.equal((await client.request(`${base}/ok`, { timeoutMs: MAX_TIMEOUT_MS * 10 })).status, 200);
});

test("oversized responses are cut off whether or not Content-Length is declared", async () => {
  const client = testClient();
  for (const path of ["/big-declared", "/big-chunked"]) {
    const err = await rejection(client.request(`${base}${path}`, { maxResponseBytes: 1024 }));
    assert.equal(err.reason, "too_large", path);
  }
  assert.equal((await client.request(`${base}/big-chunked`, { maxResponseBytes: 64 * 1024 })).text().length, 20 * 1024);
});

test("tenant-facing error descriptions never echo destinations or transport detail", () => {
  for (const reason of ["address", "dns", "scheme", "redirect", "timeout", "too_large", "tls", "network"] as const) {
    const text = describeOutboundError(new OutboundRequestError(["timeout", "too_large", "tls", "network"].includes(reason) ? false : true, reason, "ECONNREFUSED"));
    assert.ok(!/ECONNREFUSED|127\.|10\.|169\.254/.test(text), text);
  }
  assert.equal(describeOutboundError(new Error("connect ECONNREFUSED 10.0.0.5:8080")), "CRM request failed");
});

// ── CRM lookup integration ─────────────────────────────────────────────

const crmConfig = (userId: number, lookupUrl: string, extra: Record<string, unknown> = {}) => ({
  id: userId,
  userId,
  name: "Fake CRM",
  isEnabled: true,
  lookupUrl,
  httpMethod: "GET",
  authType: "bearer",
  authValue: `${CRM_SECRET}-${userId}`,
  authHeaderName: null,
  phoneParamName: "phone",
  phoneParamLocation: "query",
  responseMapping: { customerName: "customer.name" },
  useRawResponse: false,
  maxContextChars: 2000,
  timeoutMs: 2000,
  cacheTtlSeconds: 0,
  widgetChatSyncEnabled: false,
  widgetChatWebhookUrl: null,
  ...extra,
});

test("legitimate CRM lookups work and each tenant only reaches its own CRM with its own credentials", async () => {
  rows.external_crm_configs = [
    crmConfig(10, `${base}/tenant-a/lookup?apiKey=${QUERY_SECRET}`),
    crmConfig(20, `https://${CRM_TEST_OTHER_HOST}:${port}/tenant-b/lookup`),
    crmConfig(30, "https://169.254.169.254/latest/meta-data/"),
  ];
  for (const id of [10, 20, 30]) invalidateExternalCrmConfigCache(id);

  const a = await fetchExternalCrmData(10, PHONE);
  assert.equal(a?.customerName, `${CUSTOMER} tenant-a`);
  const b = await fetchExternalCrmData(20, PHONE);
  assert.equal(b?.customerName, `${CUSTOMER} tenant-b`);
  assert.equal(await fetchExternalCrmData(30, PHONE), null);
  assert.deepEqual(
    hits.map((h) => [h.path, h.authorization, h.host]),
    [
      ["/tenant-a/lookup", `Bearer ${CRM_SECRET}-10`, `${CRM_TEST_HOST}:${port}`],
      ["/tenant-b/lookup", `Bearer ${CRM_SECRET}-20`, `${CRM_TEST_OTHER_HOST}:${port}`],
    ],
  );
  assert.equal(logs.find((l) => l.msg === "External CRM destination rejected")?.userId, 30);
  assertNoLeak([PHONE, PHONE_DIGITS, QUERY_SECRET, CRM_SECRET, CUSTOMER, ORDER_ID]);
});

test("internal CRM destinations are rejected before any request, and logs stay clean", async () => {
  crmTestDns.set("internal.dialog.test", ["10.0.0.5"]);
  crmTestDns.set("mixed.dialog.test", ["127.0.0.1", "169.254.169.254"]);
  const destinations = [
    `http://${CRM_TEST_HOST}:${port}/lookup?token=${QUERY_SECRET}`,
    `https://169.254.169.254/latest/meta-data/?token=${QUERY_SECRET}`,
    `https://[::ffff:127.0.0.2]:${port}/lookup?token=${QUERY_SECRET}`,
    `https://127.0.0.2:${port}/lookup`,
    `https://internal.dialog.test/lookup?token=${QUERY_SECRET}`,
    `https://mixed.dialog.test:${port}/lookup?token=${QUERY_SECRET}`,
    `https://unknown.dialog.test/lookup?token=${QUERY_SECRET}`,
    `https://admin:${QUERY_SECRET}@${CRM_TEST_HOST}:${port}/lookup`,
    `https://${CRM_TEST_HOST}:22/lookup`,
  ];
  for (const [i, url] of destinations.entries()) {
    rows.external_crm_configs = [crmConfig(10, url)];
    invalidateExternalCrmConfigCache(10);
    assert.equal(await fetchExternalCrmData(10, `${PHONE}${i}`), null, url);
    const result = await testExternalCrmLookup(10, PHONE);
    assert.equal(result.success, false);
    assert.equal(result.error, "CRM URL is not allowed: it must be a public HTTPS address", url);
  }
  assert.equal(attempts.length, 0, "no socket opened for a rejected destination");
  assert.equal(connections, 0);
  assert.equal(hits.length, 0);
  const rejected = logs.filter((l) => l.msg === "External CRM destination rejected");
  assert.equal(rejected.length, destinations.length * 2);
  assertNoLeak([PHONE, PHONE_DIGITS, QUERY_SECRET, CRM_SECRET, "meta-data", "10.0.0.5", "token="]);
});

test("the admin test endpoint reports transport failures without addresses, ports or remote text", async () => {
  const closed = await listenCrmFixture(() => {});
  closed.server.close();
  await once(closed.server, "close");
  rows.external_crm_configs = [crmConfig(10, `${closed.base}/lookup`)];
  const refused = await testExternalCrmLookup(10, PHONE);
  assert.deepEqual(refused, { success: false, error: "CRM request failed" });
  rows.external_crm_configs = [crmConfig(10, `${base}/redirect-metadata`)];
  const redirected = await testExternalCrmLookup(10, PHONE);
  assert.equal(redirected.error, "CRM responded with a redirect, which is not followed");
});

test("widget chat sync and CRM event webhooks share the same protection", async () => {
  rows.external_crm_configs = [
    crmConfig(10, `${base}/lookup`, {
      widgetChatSyncEnabled: true,
      widgetChatWebhookUrl: `https://169.254.169.254/latest/meta-data/?token=${QUERY_SECRET}`,
    }),
  ];
  rows.widget_chat_sessions = [];
  const session = { sessionId: "sess-synthetic", phone: PHONE, activeOrderId: ORDER_ID, customerName: CUSTOMER } as any;
  await recordWidgetChatTurn(10, session, "synthetic question", "synthetic answer");
  assert.equal(logs.find((l) => l.msg === "Widget chat CRM webhook destination rejected")?.reason, "address");

  rows.external_crm_configs[0].widgetChatWebhookUrl = `${base}/chat-hook`;
  await recordWidgetChatTurn(10, session, "synthetic question", "synthetic answer");
  assert.equal(hits.filter((h) => h.path === "/chat-hook").length, 1, "a public HTTPS chat webhook is still delivered");

  rows.tenants = [{ id: 1, ownerId: 10, status: "active" }];
  rows.crm_api_keys = [
    { id: 1, userId: 10, tenantId: 1, isActive: true, webhookUrl: `https://10.0.0.5/hook?secret=${QUERY_SECRET}`, webhookSecret: "fake-signing-secret" },
    { id: 2, userId: 10, tenantId: 1, isActive: true, webhookUrl: `${base}/event-hook`, webhookSecret: "fake-signing-secret" },
  ];
  rows.webhook_deliveries = [];
  startWebhookDispatcher();
  crmEventBus.emitCallEvent({
    type: "call.turn",
    callId: 1,
    userId: 10,
    callSid: "CA" + "f".repeat(32),
    data: { role: "user", content: "synthetic", phone: PHONE },
    timestamp: new Date().toISOString(),
  } as any);
  for (let i = 0; i < 200 && rows.webhook_deliveries.filter((d: any) => d.attempts === 1).length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const blockedDelivery = rows.webhook_deliveries.find((d: any) => d.apiKeyId === 1);
  const delivered = rows.webhook_deliveries.find((d: any) => d.apiKeyId === 2);
  assert.equal(blockedDelivery.responseBody, "Delivery blocked: address");
  assert.equal(blockedDelivery.responseStatus, 0);
  assert.equal(delivered.status, "delivered");
  assert.ok(attempts.every((a) => a.host === "127.0.0.1"));
  assertNoLeak([PHONE, QUERY_SECRET, "fake-signing-secret", "10.0.0.5", ORDER_ID, CUSTOMER]);
});

// ── Configuration-time validation ──────────────────────────────────────

test("configuration routes reject non-public or non-HTTPS CRM URLs and reserved auth headers without DNS", async (t) => {
  rows.tenants = [{ id: 1, ownerId: 10, status: "active" }];
  rows.crm_api_keys = [{ id: 1, keyHash: hash(CRM_KEY), userId: 10, tenantId: 1, scopes: ["*"], isActive: true }];
  rows.external_crm_configs = [];
  const app = express();
  app.use(express.json());
  app.use("/api", crmRouter);
  app.use("/api", (req: any, _res: any, next: any) => {
    req.userId = 10;
    next();
  }, externalCrmRouter);
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const appBase = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${appBase}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

  const valid = { name: "CRM", lookupUrl: "https://crm.example.com/customers/{phone}", phoneParamLocation: "path" };
  for (const body of [
    { ...valid, lookupUrl: "http://crm.example.com/lookup" },
    { ...valid, lookupUrl: "https://169.254.169.254/latest/meta-data/" },
    { ...valid, lookupUrl: "https://[::1]/lookup" },
    { ...valid, lookupUrl: "https://user:pw@crm.example.com/lookup" },
    { ...valid, lookupUrl: "https://{phone}.crm.example.com/lookup" },
    { ...valid, widgetChatWebhookUrl: "https://10.0.0.5/hook" },
    { ...valid, authType: "header", authHeaderName: "Host" },
    { ...valid, authType: "header", authHeaderName: "X-Bad\r\nInjected" },
  ]) {
    const res = await send("PUT", "/external-crm/config", body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(rows.external_crm_configs.length, 0);
  const saved = await send("PUT", "/external-crm/config", { ...valid, authType: "header", authHeaderName: "X-Auth-Token", widgetChatWebhookUrl: "https://hooks.example.com/chat" });
  assert.equal(saved.status, 201);

  const auth = { Authorization: `Bearer ${CRM_KEY}` };
  for (const webhookUrl of ["http://hooks.example.com/x", "https://127.0.0.2/x", "https://169.254.169.254/x", "https://metadata.localhost/x", "https://[::ffff:10.0.0.1]/x"]) {
    const res = await send("POST", "/crm/webhooks", { webhookUrl }, auth);
    assert.equal(res.status, 400, webhookUrl);
  }
  assert.equal(rows.crm_api_keys[0].webhookUrl, undefined);
  assert.equal((await send("POST", "/crm/webhooks", { webhookUrl: "https://hooks.example.com/dialog" }, auth)).status, 200);
  assert.deepEqual(crmDnsQueries, [], "configuration checks never resolve tenant hostnames");
  assert.equal(attempts.length, 0);
});
