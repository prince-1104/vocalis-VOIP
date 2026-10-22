import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import express from "express";
import { rows, resetDatabase } from "./fake-db";
import { emitted, logs, resetLogs } from "./capture-logger";
import { resetRateLimitingForTests } from "../src/lib/rate-limit";
import { aiBehavior, chatPrompts } from "./fake-ai";
import { listenCrmFixture } from "./fake-crm-http";
import widgetRouter from "../src/routes/widget";
import settingsRouter from "../src/routes/widget-verification-settings";
import { resolveUser, requireRole, signToken } from "../src/middleware/auth";
import { invalidateExternalCrmConfigCache } from "../src/lib/external-crm-lookup";
import {
  createWidgetVerification,
  setWidgetVerification,
  MAX_ATTEMPTS,
  type ActiveVerificationPolicy,
} from "../src/lib/widget-verification";
import { savePolicy } from "../src/lib/widget-verification-policy";
import {
  matchOrdersBySuffix,
  normalizeCrmDob,
  normalizeSubmittedDob,
  normalizeSubmittedDigits,
  resolveTrustedField,
} from "../src/lib/widget-verification-factors";

const keyA = "wk_fake_" + "a".repeat(40);
const keyB = "wk_fake_" + "b".repeat(40);
const ALICE = "9000000001";
const CAROL = "9000000003";
const UNKNOWN = "9000000009";
const ALICE_DOB = "17/05/1990";

const crmData: Record<string, Record<string, any>> = {};
function resetCrm() {
  crmData.a = {
    [ALICE]: {
      found: true,
      customer: { name: "Synthetic Alice", dateOfBirth: ALICE_DOB },
      orders: [
        { orderId: "ORD-0001234", status: "alice-alpha-status" },
        { orderId: "550009876", status: "alice-beta-status" },
        { orderId: "88005555", status: "alice-gamma-status" },
        { orderId: "99015555", status: "alice-delta-status" },
        { orderId: "000042", status: "alice-zero-status" },
      ],
    },
    [CAROL]: {
      found: true,
      customer: { name: "Synthetic Carol" },
      orders: [{ orderId: "3333", status: "carol-only-status" }],
    },
  };
  crmData.b = {
    [ALICE]: {
      found: true,
      customer: { name: "Tenant B Person", dateOfBirth: "01/01/1980" },
      orders: [{ orderId: "4449876", status: "tenant-b-status" }],
    },
  };
}
const crmHits: { tenant: string; phone: string }[] = [];
const PRIVATE = [
  "Synthetic Alice", "Synthetic Carol", "Tenant B Person",
  "ORD-0001234", "550009876", "88005555", "99015555", "000042", "4449876",
  "alice-alpha-status", "alice-beta-status", "alice-gamma-status", "alice-delta-status",
  "alice-zero-status", "carol-only-status", "tenant-b-status", ALICE_DOB, "1990-05-17",
];
const assertNoCustomerData = (text: string) => {
  for (const value of PRIVATE) assert.ok(!text.includes(value), `disclosed ${value}: ${text}`);
};

let crmServer: import("node:https").Server;
let crmBase = "";
let appServer: Server;
let base = "";
before(async () => {
  const crm = express();
  crm.get("/:tenant/lookup", (req, res) => {
    const phone = String(req.query.phone);
    crmHits.push({ tenant: req.params.tenant, phone });
    res.json(crmData[req.params.tenant]?.[phone] ?? { found: false });
  });
  ({ server: crmServer, base: crmBase } = await listenCrmFixture(crm));
  // Same order as app.ts: public widget routes, then resolveUser, then the
  // admin-only settings router.
  const app = express();
  app.use(express.json());
  app.use(widgetRouter);
  app.use(resolveUser);
  app.use(requireRole("admin"), settingsRouter);
  appServer = createServer(app).listen(0, "127.0.0.1");
  await once(appServer, "listening");
  base = `http://127.0.0.1:${(appServer.address() as any).port}`;
});
after(() => {
  for (const server of [crmServer, appServer]) {
    server.closeAllConnections();
    server.close();
  }
  for (const timer of (globalThis as any).__dialogTestIntervals ?? []) clearInterval(timer);
});

let clock = new Date("2026-01-01T00:00:00Z");
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
function installService() {
  setWidgetVerification(createWidgetVerification({ sender: null, now: () => clock }));
}

const crmConfig = (id: number, userId: number, tenant: string) => ({
  id,
  userId,
  name: "Fake CRM " + tenant,
  isEnabled: true,
  lookupUrl: `${crmBase}/${tenant}/lookup`,
  httpMethod: "GET",
  authType: "bearer",
  authValue: null,
  phoneParamName: "phone",
  phoneParamLocation: "query",
  responseMapping: null,
  useRawResponse: false,
  maxContextChars: 2000,
  timeoutMs: 3000,
  cacheTtlSeconds: 0,
  widgetChatSyncEnabled: false,
});

const jti = (c: string) => c.repeat(64);
const TOKENS = {
  adminA: signToken({ tenantUserId: 101, jti: jti("a") }),
  managerA: signToken({ tenantUserId: 102, jti: jti("b") }),
  adminB: signToken({ tenantUserId: 201, jti: jti("c") }),
};

beforeEach(() => {
  resetDatabase();
  // Per-address HTTP budgets are covered in rate-limit.test.ts; every request here shares one address.
  resetRateLimitingForTests();
  resetLogs();
  resetCrm();
  crmHits.length = 0;
  chatPrompts.length = 0;
  aiBehavior.chatReply = null;
  clock = new Date("2026-01-01T00:00:00Z");
  for (const id of [10, 20]) invalidateExternalCrmConfigCache(id);
  rows.users = [{ id: 10 }, { id: 20 }];
  rows.tenants = [
    { id: 1, ownerId: 10, status: "active" },
    { id: 2, ownerId: 20, status: "active" },
  ];
  const member = (id: number, tenantId: number, role: string) => ({
    id, tenantId, userId: null, role, email: `user${id}@example.test`, isActive: true, name: "Fake " + id,
  });
  rows.tenant_users = [member(101, 1, "admin"), member(102, 1, "manager"), member(201, 2, "admin")];
  const session = (id: number, tenantUserId: number, tenantId: number, token: string) => ({
    id, token, tenantUserId, tenantId, expiresAt: new Date(Date.now() + 60 * 60_000), revokedAt: null,
  });
  rows.tenant_sessions = [session(1, 101, 1, jti("a")), session(2, 102, 1, jti("b")), session(3, 201, 2, jti("c"))];
  const agent = (id: number, userId: number, widgetApiKey: string) => ({
    id,
    userId,
    agentName: "Fake agent " + id,
    greeting: "Fake greeting " + id,
    personality: "friendly",
    language: "en-US",
    widgetApiKey,
    widgetEnabled: true,
    widgetExternalCrmEnabled: true,
  });
  rows.agent_configs = [agent(1, 10, keyA), agent(2, 20, keyB)];
  rows.external_crm_configs = [crmConfig(1, 10, "a"), crmConfig(2, 20, "b")];
  installService();
});

async function call(method: string, route: string, body?: any, token?: string) {
  const res = await fetch(base + route, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}
const post = (route: string, body: any) => call("POST", route, body);
const getPolicy = (token?: string) => call("GET", "/widget-verification/policy", undefined, token);
const putPolicy = (body: any, token = TOKENS.adminA) => call("PUT", "/widget-verification/policy", body, token);
async function enable(body: any = {}, token = TOKENS.adminA) {
  const res = await putPolicy({ enabled: true, ...body }, token);
  assert.equal(res.status, 200, res.text);
  return res.json;
}

const start = (phone: string, apiKey = keyA, extra: any = {}) =>
  post("/widget/crm/verification/start", { apiKey, phone, ...extra });
const verify = (challengeId: string, factor: any, apiKey = keyA) =>
  post("/widget/crm/verification/verify", { apiKey, challengeId, ...factor });
const selectOrder = (sessionToken: string, orderId: string, apiKey = keyA) =>
  post("/widget/crm/select-order", { apiKey, sessionToken, orderId });
const chat = (crmSessionToken: string | undefined, message: string, apiKey = keyA) =>
  post("/widget/chat", { apiKey, message, crmSessionToken });
async function challenge(phone = ALICE, apiKey = keyA) {
  const res = await start(phone, apiKey);
  assert.equal(res.status, 200, res.text);
  return res.json.challengeId as string;
}
async function digitsSession(digits: string, phone = ALICE, apiKey = keyA) {
  const res = await verify(await challenge(phone, apiKey), { orderDigits: digits }, apiKey);
  assert.equal(res.status, 200, res.text);
  return res.json;
}

test("unconfigured or disabled tenants get general chat only and no customer data", async () => {
  for (const state of ["missing", "disabled"]) {
    if (state === "disabled")
      rows.widget_verification_policies = [
        { id: 1, tenantId: 1, enabled: false, method: "order_suffix_4", dobFieldPath: null, dobFormat: null, version: 3 },
      ];
    const config = await fetch(base + `/widget/config/${keyA}`).then((r) => r.json());
    assert.equal(config.crmAuthRequired, false, state);
    assert.equal(config.crmVerification, null);
    const started = await start(ALICE);
    assert.equal(started.status, 403);
    assert.equal(started.json.error, "customer_access_disabled");
    assert.equal((await verify("00000000-0000-4000-8000-000000000000", { orderDigits: "1234" })).status, 403);
    aiBehavior.chatReply = "Fake general reply";
    const general = await chat(undefined, "What is the status of my latest order?");
    assert.equal(general.status, 200);
    assert.equal(general.json.reply, "Fake general reply");
    assertNoCustomerData(general.text + JSON.stringify(chatPrompts));
  }
  assert.equal(crmHits.length, 0, "no CRM lookups without an active policy");
  assert.equal(rows.widget_verification_challenges?.length ?? 0, 0);
});

test("only authenticated tenant admins can read or change the policy", async () => {
  assert.equal((await getPolicy()).status, 401);
  assert.equal((await putPolicy({ enabled: true }, "not-a-token")).status, 401);
  assert.equal((await getPolicy(TOKENS.managerA)).status, 403);
  assert.equal((await putPolicy({ enabled: true }, TOKENS.managerA)).status, 403);
  assert.equal(rows.widget_verification_policies?.length ?? 0, 0);

  const initial = await getPolicy(TOKENS.adminA);
  assert.equal(initial.status, 200);
  assert.equal(initial.json.status, "disabled");
  assert.deepEqual(
    { enabled: initial.json.policy.enabled, method: initial.json.policy.method, version: initial.json.policy.version },
    { enabled: false, method: "order_suffix_4", version: 0 },
  );
  const saved = await enable();
  assert.equal(saved.status, "active");
  assert.equal(saved.policy.method, "order_suffix_4", "enabling defaults to phone + 4 digits");
  assert.equal(saved.policy.version, 1);
  assert.equal(rows.widget_verification_policies[0].updatedByTenantUserId, 101);

  rows.tenant_sessions[0].revokedAt = new Date();
  assert.equal((await putPolicy({ enabled: false })).status, 401, "revoked dashboard session");
  assert.equal(rows.widget_verification_policies[0].enabled, true);
});

test("tenant A cannot read or modify tenant B's policy through caller-supplied identifiers", async () => {
  await enable({ method: "order_suffix_6" }, TOKENS.adminB);
  for (const field of ["tenantId", "ownerId", "agentId", "widgetId", "userId"]) {
    const res = await putPolicy({ enabled: false, [field]: 2 });
    assert.equal(res.status, 400, field);
    assert.equal(res.json.field, field);
  }
  const mine = await enable();
  assert.equal(mine.policy.method, "order_suffix_4");
  const tenantB = rows.widget_verification_policies.find((p) => p.tenantId === 2);
  assert.deepEqual([tenantB.enabled, tenantB.method, tenantB.version], [true, "order_suffix_6", 1]);
  assert.equal((await getPolicy(TOKENS.adminB)).json.policy.method, "order_suffix_6");
  assert.equal((await getPolicy(TOKENS.adminA)).json.policy.method, "order_suffix_4");
  const query = await call("GET", "/widget-verification/policy?tenantId=2", undefined, TOKENS.adminA);
  assert.equal(query.json.policy.method, "order_suffix_4", "query parameters are ignored");
});

test("each policy validates its required configuration; unsupported methods are never silently downgraded", async () => {
  const rejects = async (body: any, field: string) => {
    const res = await putPolicy(body);
    assert.equal(res.status, 400, JSON.stringify(body) + res.text);
    assert.equal(res.json.field, field);
  };
  await rejects({ method: "order_suffix_4" }, "enabled");
  await rejects({ enabled: "yes" }, "enabled");
  await rejects({ enabled: true, method: "order_suffix_5" }, "method");
  await rejects({ enabled: true, method: "custom_sql" }, "method");
  await rejects({ enabled: true, method: "date_of_birth" }, "dobFieldPath");
  await rejects({ enabled: true, method: "date_of_birth", dobFieldPath: "customer.dateOfBirth" }, "dobFormat");
  for (const bad of ["__proto__.polluted", "customer.constructor", "a..b", "customer[0]", "x;drop table", "a.b.c.d.e.f.g"])
    await rejects({ enabled: true, method: "date_of_birth", dobFieldPath: bad, dobFormat: "DD/MM/YYYY" }, "dobFieldPath");
  await rejects({ enabled: true, method: "date_of_birth", dobFieldPath: "customer.dateOfBirth", dobFormat: "YYYYMMDD" }, "dobFormat");
  await rejects({ enabled: true, method: "sms_otp" }, "method");
  assert.match((await putPolicy({ enabled: true, method: "sms_otp" })).json.error, /delivery provider/);

  rows.external_crm_configs[0].isEnabled = false;
  await rejects({ enabled: true }, "method");
  rows.external_crm_configs[0].isEnabled = true;
  const original = process.env.WIDGET_VERIFICATION_KEY;
  process.env.WIDGET_VERIFICATION_KEY = "";
  try {
    await rejects({ enabled: true }, "method");
  } finally {
    process.env.WIDGET_VERIFICATION_KEY = original;
  }
  assert.equal(rows.widget_verification_policies?.length ?? 0, 0, "nothing stored for invalid input");

  // A disabled draft may name an unavailable method; it never becomes active.
  const draft = await putPolicy({ enabled: false, method: "sms_otp" });
  assert.equal(draft.status, 200);
  assert.equal(draft.json.status, "disabled");
  const dob = await enable({ method: "date_of_birth", dobFieldPath: "customer.dateOfBirth", dobFormat: "DD/MM/YYYY" });
  assert.equal(dob.status, "active");
  const unchanged = await putPolicy({ enabled: true });
  assert.equal(unchanged.json.changed, false);
  assert.equal(unchanged.json.policy.version, dob.policy.version);

  // CRM removed after enabling: the admin is told, and the widget blocks access.
  rows.external_crm_configs[0].isEnabled = false;
  const view = (await getPolicy(TOKENS.adminA)).json;
  assert.equal(view.status, "needs_attention");
  assert.equal((await start(ALICE)).status, 403);
  assert.equal(crmHits.length, 0);
});

test("phone + last 4 digits binds a short-lived session to exactly one order", async () => {
  await enable();
  const config = await fetch(base + `/widget/config/${keyA}`).then((r) => r.json());
  assert.deepEqual(config.crmVerification, { method: "order_suffix_4", factor: "order_digits", length: 4 });
  const started = await start(ALICE);
  assert.equal(started.json.factor, "order_digits");
  assertNoCustomerData(started.text);
  assert.equal(crmHits.length, 0, "starting reveals nothing and performs no lookup");
  const res = await verify(started.json.challengeId, { orderDigits: "1234" });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.orderSelected, true);
  assert.equal(res.json.orderId, "ORD-0001234");
  assert.match(res.json.greeting, /Synthetic Alice.*ORD-0001234/);
  const session = rows.widget_customer_sessions[0];
  assert.deepEqual([session.scope, session.method, session.policyVersion], ["order", "order_suffix_4", 1]);
  assert.equal(session.expiresAt.getTime() - clock.getTime(), 30 * 60_000);

  aiBehavior.chatReply = "Fake order reply";
  const reply = await chat(res.json.sessionToken, "Where is my order?");
  assert.equal(reply.status, 200, reply.text);
  const prompt = JSON.stringify(chatPrompts.at(-1));
  assert.ok(prompt.includes("alice-alpha-status"));
  for (const other of ["alice-beta-status", "alice-gamma-status", "alice-delta-status", "alice-zero-status", "550009876", "carol-only-status", "tenant-b-status", ALICE_DOB])
    assert.ok(!prompt.includes(other), `prompt leaked ${other}`);

  const switched = await chat(res.json.sessionToken, "What about order 550009876?");
  assert.match(switched.json.reply, /limited to the order you verified/);
  assert.ok(!switched.text.includes("alice-beta-status"));
  assert.equal((await selectOrder(res.json.sessionToken, "550009876")).status, 404);
  assert.equal(rows.widget_customer_sessions[0].activeOrderId, "ORD-0001234");
});

test("phone + last 6 digits is a distinct policy; leading zeros stay significant", async () => {
  await enable();
  assert.equal((await digitsSession("0042")).orderId, "000042", "leading zeros in a 4-digit suffix");
  const shortId = await challenge();
  for (const tooShort of ["42", "042", "1 2 3"])
    assert.equal((await verify(shortId, { orderDigits: tooShort })).status, 400, tooShort);
  assert.equal((await digitsSession("0001234")).orderId, "ORD-0001234", "more digits than required");

  advance(16 * 60_000);
  const six = await enable({ method: "order_suffix_6" });
  assert.equal(six.policy.version, 2);
  const started = await start(ALICE);
  assert.deepEqual([started.json.factor, started.json.length], ["order_digits", 6]);
  assert.equal((await verify(started.json.challengeId, { orderDigits: "1234" })).status, 400, "4 digits rejected");
  assert.equal((await verify(started.json.challengeId, { orderDigits: "001234" })).json.orderId, "ORD-0001234");
  advance(16 * 60_000);
  const zeroMismatch = await verify(await challenge(), { orderDigits: "000043" });
  assert.equal(zeroMismatch.status, 400);
  assert.equal((await digitsSession("000042")).orderId, "000042");

  // Unit checks of the normalization rules.
  assert.equal(normalizeSubmittedDigits("#00 42", 4), "0042");
  assert.equal(normalizeSubmittedDigits("12a4", 4), null);
  assert.deepEqual(
    matchOrdersBySuffix([{ orderId: "A1B2C3" }, { orderId: "#0042" }, { orderId: "10042" }] as any, "0042").map((o) => o.orderId),
    ["#0042", "10042"],
  );
});

test("ambiguous suffixes are rejected without disclosing the matches", async () => {
  await enable();
  const id = await challenge();
  const ambiguous = await verify(id, { orderDigits: "5555" });
  const wrong = await verify(id, { orderDigits: "4321" });
  assert.equal(ambiguous.status, 400);
  assert.equal(ambiguous.text, wrong.text);
  assertNoCustomerData(ambiguous.text);
  assert.ok(logs.some((l) => l.event === "widget_verification_failed" && l.reason === "ambiguous"));
  assert.equal(rows.widget_customer_sessions?.length ?? 0, 0);
  const longer = await verify(id, { orderDigits: "015555" });
  assert.equal(longer.status, 200, "more digits resolve the ambiguity");
  assert.equal(longer.json.orderId, "99015555");
});

test("date of birth verifies only against a trusted, mapped CRM field", async () => {
  // Unit rules: strict per-format CRM parsing; customer input is DD/MM/YYYY or ISO.
  assert.equal(normalizeCrmDob("17/05/1990", "DD/MM/YYYY"), "1990-05-17");
  assert.equal(normalizeCrmDob("05/17/1990", "MM/DD/YYYY"), "1990-05-17");
  assert.equal(normalizeCrmDob("1990-05-17T00:00:00Z", "YYYY-MM-DD"), null);
  assert.equal(normalizeCrmDob("31/02/1990", "DD/MM/YYYY"), null);
  assert.equal(normalizeCrmDob(642902400000, "YYYY-MM-DD"), null);
  assert.equal(normalizeSubmittedDob("1990-05-17"), "1990-05-17");
  assert.equal(normalizeSubmittedDob("17.5.1990"), "1990-05-17");
  assert.equal(normalizeSubmittedDob("May 17 1990"), null);
  assert.equal(resolveTrustedField({ customer: Object.create({ dateOfBirth: "inherited" }) }, "customer.dateOfBirth"), undefined);

  await enable({ method: "date_of_birth", dobFieldPath: "customer.dateOfBirth", dobFormat: "DD/MM/YYYY" });
  const config = await fetch(base + `/widget/config/${keyA}`).then((r) => r.text());
  assert.ok(!config.includes("dateOfBirth") && !config.includes("customer."), "field mapping is never public");

  const id = await challenge();
  // Browser-supplied "reference" values and mappings are ignored.
  const spoofed = await post("/widget/crm/verification/verify", {
    apiKey: keyA, challengeId: id, dateOfBirth: "01/01/2000",
    referenceDateOfBirth: "01/01/2000", dobFieldPath: "customer.name", method: "order_suffix_4", orderDigits: "1234",
  });
  assert.equal(spoofed.status, 400);
  const ok = await verify(id, { dateOfBirth: "1990-05-17" });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.orderSelected, false);
  assertNoCustomerData(ok.text);
  assert.equal(rows.widget_customer_sessions[0].scope, "customer");
  assert.equal((await chat(ok.json.sessionToken, "hi")).json.crmOrderRequired, true);
  const selected = await selectOrder(ok.json.sessionToken, "550009876");
  assert.equal(selected.status, 200);
  aiBehavior.chatReply = "Fake dob reply";
  await chat(ok.json.sessionToken, "status?");
  const prompt = JSON.stringify(chatPrompts.at(-1));
  assert.ok(prompt.includes("alice-beta-status") && !prompt.includes("alice-alpha-status"));
  assert.ok(!prompt.includes(ALICE_DOB) && !prompt.includes("1990-05-17"), "reference date never reaches the model");

  const carol = await verify(await challenge(CAROL), { dateOfBirth: "17/05/1990" });
  assert.equal(carol.status, 400, "no trusted DOB on record");
  assert.ok(logs.some((l) => l.event === "widget_verification_failed" && l.reason === "reference_unavailable"));

  // A mapping whose format does not match the CRM's representation fails closed.
  advance(16 * 60_000);
  await enable({ method: "date_of_birth", dobFieldPath: "customer.dateOfBirth", dobFormat: "YYYY-MM-DD" });
  assert.equal((await verify(await challenge(), { dateOfBirth: ALICE_DOB })).status, 400);
  await enable({ method: "date_of_birth", dobFieldPath: "customer.name", dobFormat: "DD/MM/YYYY" });
  assert.equal((await verify(await challenge(), { dateOfBirth: ALICE_DOB })).status, 400);
});

test("wrong, missing or malformed factors fail identically and disclose nothing", async () => {
  await enable();
  await enable({}, TOKENS.adminB);
  const id = await challenge();
  const unknownId = await challenge(UNKNOWN);
  const failures = [
    await verify(id, { orderDigits: "4321" }),
    await verify(id, {}),
    await verify(id, { orderDigits: "abcd" }),
    await verify(id, { code: "123456" }),
    await verify(unknownId, { orderDigits: "1234" }),
    await verify(id, { orderDigits: "9876" }, keyB),
    await verify("00000000-0000-4000-8000-000000000000", { orderDigits: "1234" }),
  ];
  for (const failure of failures) {
    assert.equal(failure.status, 400);
    assert.equal(failure.text, failures[0].text);
  }
  assertNoCustomerData(failures.map((f) => f.text).join());
  const known = await start(ALICE);
  const unknown = await start(UNKNOWN);
  assert.equal(known.text.replace(known.json.challengeId, ""), unknown.text.replace(unknown.json.challengeId, ""));
});

test("expired, replayed, revoked and mis-scoped challenges and sessions are rejected", async () => {
  await enable();
  await enable({}, TOKENS.adminB);
  const expiring = await challenge();
  advance(5 * 60_000 + 1);
  assert.equal((await verify(expiring, { orderDigits: "1234" })).status, 400, "expired challenge");
  const id = await challenge();
  const first = await verify(id, { orderDigits: "1234" });
  assert.equal(first.status, 200);
  assert.equal((await verify(id, { orderDigits: "1234" })).status, 400, "replayed challenge");
  const token = first.json.sessionToken;
  aiBehavior.chatReply = "Fake reply";
  assert.equal((await chat(token, "hi")).status, 200);
  assert.equal((await chat(token, "hi", keyB)).status, 403, "other tenant's widget");
  assert.equal((await chat(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), "hi")).status, 403);
  assert.equal((await post("/widget/crm/session/end", { apiKey: keyA, sessionToken: token })).status, 200);
  assert.equal((await chat(token, "hi")).status, 403, "revoked");
  const second = (await digitsSession("9876")).sessionToken;
  advance(30 * 60_000 + 1);
  assert.equal((await chat(second, "hi")).status, 403, "expired session");
});

test("attempts are capped per challenge and per phone; concurrent submissions cannot exceed them", async () => {
  await enable();
  const id = await challenge();
  for (let i = 0; i < MAX_ATTEMPTS; i++) assert.equal((await verify(id, { orderDigits: "4321" })).status, 400);
  assert.equal((await verify(id, { orderDigits: "1234" })).status, 400, "locked after the cap");

  for (let round = 0; round < 2; round++) {
    const next = await challenge();
    for (let i = 0; i < MAX_ATTEMPTS; i++) await verify(next, { orderDigits: "4321" });
  }
  advance(16 * 60_000);
  const budget = await start(ALICE);
  assert.equal(budget.status, 429, "daily failed-attempt budget per phone");
  assert.equal((await start(CAROL)).status, 200, "other phones unaffected");

  // Same-tick service calls interleave every data-layer step.
  const service = createWidgetVerification({ sender: null, now: () => clock });
  const agent = { id: 1, userId: 10 };
  const policy: ActiveVerificationPolicy = { tenantId: 1, version: 1, method: "order_suffix_4", dobFieldPath: null, dobFormat: null };
  const issue = async (phone: string) => {
    const started = await service.start({ agent, apiKey: keyA, phone, source: "10.0.0.9", policy });
    assert.ok(started.ok);
    return started.challengeId;
  };
  const winnerId = await issue(CAROL);
  const winners = await Promise.all(
    Array.from({ length: 10 }, () => service.verify({ agent, apiKey: keyA, policy, challengeId: winnerId, orderDigits: "3333" })),
  );
  assert.equal(winners.filter((w) => w.ok).length, 1);
  const bruteId = await issue(CAROL);
  resetLogs();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      service.verify({ agent, apiKey: keyA, policy, challengeId: bruteId, orderDigits: String(1000 + i) }),
    ),
  );
  const compared = logs.filter((l) => l.event === "widget_verification_failed" && l.reason === "mismatch").length;
  assert.ok(compared <= MAX_ATTEMPTS, `factors compared: ${compared}`);
  assert.ok(rows.widget_verification_challenges.find((c) => c.id === bruteId).attempts <= MAX_ATTEMPTS);
});

test("policy changes invalidate outstanding sessions and challenges; concurrent edits cannot both win", async () => {
  await enable();
  const token = (await digitsSession("1234")).sessionToken;
  const pendingId = await challenge(CAROL);
  aiBehavior.chatReply = "Fake reply";
  assert.equal((await chat(token, "hi")).status, 200);
  await enable({ method: "order_suffix_6" });
  assert.equal((await chat(token, "hi")).status, 403, "method change");
  assert.equal(rows.widget_customer_sessions[0].state, "revoked");
  assert.equal((await verify(pendingId, { orderDigits: "003333" })).status, 400, "challenge from old policy");

  // Even without the explicit revocation, the version check rejects old sessions.
  const fresh = (await digitsSession("001234")).sessionToken;
  rows.widget_verification_policies[0].version += 1;
  assert.equal((await chat(fresh, "hi")).status, 403, "version mismatch");

  const actor = { tenantId: 1, ownerId: 10, tenantUserId: 101 };
  const version = rows.widget_verification_policies[0].version;
  const results = await Promise.all([
    savePolicy(actor, { enabled: true, method: "order_suffix_4" }),
    savePolicy(actor, { enabled: false }),
  ]);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  assert.equal(results.find((r) => !r.ok && r.status === 409) !== undefined, true);
  assert.equal(rows.widget_verification_policies[0].version, version + 1);
});

test("disabling customer access blocks new and existing sessions immediately", async () => {
  await enable();
  const token = (await digitsSession("1234")).sessionToken;
  aiBehavior.chatReply = "Fake reply";
  assert.equal((await chat(token, "hi")).status, 200);
  const hits = crmHits.length;
  chatPrompts.length = 0;
  const off = await putPolicy({ enabled: false });
  assert.equal(off.json.status, "disabled");
  const after = await chat(token, "What is the status of my latest order?");
  assert.equal(after.status, 200, "general chat continues");
  assertNoCustomerData(after.text + JSON.stringify(chatPrompts));
  assert.equal(crmHits.length, hits, "no CRM lookup once disabled");
  assert.equal((await start(ALICE)).status, 403);
  assert.equal((await selectOrder(token, "ORD-0001234")).status, 403);
  await enable();
  assert.equal((await chat(token, "hi")).status, 403, "re-enabling does not revive old sessions");

  rows.agent_configs[0].widgetExternalCrmEnabled = false;
  const fresh = (await getPolicy(TOKENS.adminA)).json;
  assert.equal(fresh.status, "needs_attention");
  assert.equal((await start(ALICE)).status, 403, "widget CRM toggle off also blocks access");
});

test("each tenant's factors are checked against its own CRM only", async () => {
  await enable();
  await enable({}, TOKENS.adminB);
  const b = await digitsSession("9876", ALICE, keyB);
  assert.equal(b.orderId, "4449876");
  aiBehavior.chatReply = "Fake reply";
  await chat(b.sessionToken, "status?", keyB);
  const prompt = JSON.stringify(chatPrompts.at(-1));
  assert.ok(prompt.includes("tenant-b-status"));
  for (const other of ["alice-beta-status", "Synthetic Alice"]) assert.ok(!prompt.includes(other));
  assert.ok(crmHits.every((h) => h.tenant === "b"));
  assert.equal((await chat(b.sessionToken, "status?", keyA)).status, 403);
  const a = await digitsSession("9876");
  assert.equal(a.orderId, "550009876");
  assert.equal((await verify(await challenge(CAROL, keyB), { orderDigits: "3333" }, keyB)).status, 400, "tenant A's customer");
});

test("logs carry no phones, factors, dates of birth, tokens, names or order details", async () => {
  await enable();
  aiBehavior.chatReply = "Fake reply";
  const id = await challenge();
  await verify(id, { orderDigits: "5555" });
  const token = (await verify(id, { orderDigits: "1234" })).json.sessionToken;
  await chat(token, "where is my parcel?");
  await enable({ method: "date_of_birth", dobFieldPath: "customer.dateOfBirth", dobFormat: "DD/MM/YYYY" });
  await verify(await challenge(), { dateOfBirth: "18/05/1990" });
  await verify(await challenge(), { dateOfBirth: ALICE_DOB });
  const out = emitted();
  assert.ok(out.includes("widget_verification_policy_updated"));
  for (const leaked of [token, ALICE, "18/05/1990", "1990-05-18", ...PRIVATE])
    assert.ok(!out.includes(leaked), `log output leaked: ${leaked}`);
  for (const factor of ["5555", "1234"]) assert.ok(!out.includes(`"${factor}"`), `log output leaked factor ${factor}`);
});

test("the loader follows the server policy and the public widget cannot select a method", async () => {
  await enable();
  const loader = await fetch(base + `/widget/loader.js?key=${keyA}`).then((r) => r.text());
  assert.doesNotThrow(() => new Script(loader));
  assert.ok(loader.includes("orderDigits") && loader.includes("dateOfBirth") && loader.includes("res.data.factor"));
  const res = await start(ALICE, keyA, { method: "date_of_birth", policyVersion: 99 });
  assert.equal(res.json.factor, "order_digits");
  assert.equal(rows.widget_verification_challenges[0].method, "order_suffix_4");
  assert.equal(rows.widget_verification_challenges[0].policyVersion, 1);
  for (const route of ["/widget/crm/verify-phone", "/widget/crm/verify-order"])
    assert.equal((await post(route, { apiKey: keyA, phone: ALICE, orderId: "ORD-0001234" })).status, 410);
});

test("the settings router is mounted behind resolveUser and the admin role in the real app", async () => {
  const source = await readFile(path.resolve("src/app.ts"), "utf8");
  const resolveAt = source.indexOf('app.use("/api", resolveUser)');
  const mountAt = source.indexOf('app.use("/api", requireRole("admin"), widgetVerificationSettingsRouter)');
  assert.ok(resolveAt > 0 && mountAt > resolveAt);
});

test("policy migration 0004 is additive and does not edit 0003", async () => {
  const directory = path.resolve("../../lib/db/drizzle");
  const previous = JSON.parse(await readFile(path.join(directory, "meta/0003_snapshot.json"), "utf8"));
  const next = JSON.parse(await readFile(path.join(directory, "meta/0004_snapshot.json"), "utf8"));
  assert.equal(next.prevId, previous.id);
  const tables = structuredClone(next.tables);
  const policyTable = tables["public.widget_verification_policies"];
  assert.ok(policyTable.indexes.widget_verification_policies_tenant_id_unique.isUnique);
  assert.deepEqual(Object.keys(policyTable.checkConstraints).sort(), [
    "widget_verification_policies_dob_config_check",
    "widget_verification_policies_dob_format_check",
    "widget_verification_policies_method_check",
    "widget_verification_policies_version_check",
  ]);
  delete tables["public.widget_verification_policies"];
  for (const [table, columns] of [
    ["public.widget_verification_challenges", ["method", "policy_version"]],
    ["public.widget_customer_sessions", ["method", "policy_version", "scope"]],
  ] as const)
    for (const column of columns) {
      assert.equal(tables[table].columns[column].notNull, true);
      assert.ok(tables[table].columns[column].default !== undefined, `${column} has a default`);
      delete tables[table].columns[column];
    }
  assert.deepEqual(tables, previous.tables);

  const sql = await readFile(path.join(directory, "0004_widget_verification_policies.sql"), "utf8");
  const statements = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  for (const statement of statements)
    assert.match(statement, /^(CREATE TABLE "widget_verification_policies"|CREATE UNIQUE INDEX|ALTER TABLE "widget_(verification_challenges|customer_sessions)" ADD COLUMN "\w+" \w+ DEFAULT [^;]+ NOT NULL;)/);
  assert.ok(!/\b(DROP|INSERT|UPDATE|DELETE|RENAME|TRUNCATE)\b/i.test(sql.replace(/ON DELETE (CASCADE|SET NULL)/g, "")));
  const journal = JSON.parse(await readFile(path.join(directory, "meta/_journal.json"), "utf8"));
  assert.deepEqual(journal.entries.slice(3, 5).map((e: any) => e.tag), [
    "0003_widget_customer_verification",
    "0004_widget_verification_policies",
  ]);
});
