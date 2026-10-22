import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import { createHmac } from "node:crypto";
import express from "express";
import { rows, resetDatabase } from "./fake-db";
import { emitted, logs, resetLogs } from "./capture-logger";
import { resetRateLimitingForTests } from "../src/lib/rate-limit";
import { aiBehavior, chatPrompts } from "./fake-ai";
import { listenCrmFixture } from "./fake-crm-http";
import widgetRouter from "../src/routes/widget";
import { invalidateExternalCrmConfigCache } from "../src/lib/external-crm-lookup";
import {
  createWidgetVerification,
  setWidgetVerification,
  MAX_ATTEMPTS,
  type VerificationCodeMessage,
} from "../src/lib/widget-verification";

const keyA = "wk_fake_" + "a".repeat(40);
const keyA2 = "wk_fake_" + "c".repeat(40);
const keyB = "wk_fake_" + "b".repeat(40);
const keyPlain = "wk_fake_" + "d".repeat(40);
const ALICE = "9000000001";
const CAROL = "9000000003";
const UNKNOWN = "9000000009";

const crmData: Record<string, Record<string, any>> = {};
function resetCrm() {
  crmData.a = {
    [ALICE]: {
      found: true,
      customer: { name: "Synthetic Alice" },
      orders: [
        { orderId: "11111", status: "shipped-alpha" },
        { orderId: "22222", status: "pending-beta" },
      ],
    },
    [CAROL]: {
      found: true,
      customer: { name: "Synthetic Carol" },
      orders: [{ orderId: "33333", status: "carol-gamma" }],
    },
  };
  crmData.b = {
    [ALICE]: {
      found: true,
      customer: { name: "Tenant B Person" },
      orders: [{ orderId: "44444", status: "tenant-b-delta" }],
    },
  };
}
const crmHits: { tenant: string; phone: string }[] = [];

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
  const app = express();
  app.use(express.json());
  app.use(widgetRouter);
  appServer = createServer(app).listen(0, "127.0.0.1");
  await once(appServer, "listening");
  base = `http://127.0.0.1:${(appServer.address() as any).port}`;
});
after(() => {
  for (const server of [crmServer, appServer]) {
    server.closeAllConnections();
    server.close();
  }
  for (const timer of (globalThis as any).__dialogTestIntervals)
    clearInterval(timer);
});

let clock = new Date("2026-01-01T00:00:00Z");
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
let sent: VerificationCodeMessage[] = [];
let pending: Promise<void>[] = [];
const settle = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};
function installService(withSender = true) {
  setWidgetVerification(
    createWidgetVerification({
      sender: withSender
        ? { send: async (message) => void sent.push(message) }
        : null,
      now: () => clock,
      schedule: (task) => void pending.push(task()),
    }),
  );
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

beforeEach(() => {
  resetDatabase();
  // Per-address HTTP budgets are covered in rate-limit.test.ts; every request here shares one address.
  resetRateLimitingForTests();
  resetLogs();
  resetCrm();
  crmHits.length = 0;
  chatPrompts.length = 0;
  aiBehavior.chatReply = null;
  sent = [];
  pending = [];
  clock = new Date("2026-01-01T00:00:00Z");
  for (const id of [10, 20, 30]) invalidateExternalCrmConfigCache(id);
  rows.users = [{ id: 10 }, { id: 20 }, { id: 30 }];
  rows.tenants = [
    { id: 1, ownerId: 10, status: "active" },
    { id: 2, ownerId: 20, status: "active" },
    { id: 3, ownerId: 30, status: "active" },
  ];
  const agent = (id: number, userId: number, widgetApiKey: string, crm: boolean) => ({
    id,
    userId,
    agentName: "Fake agent " + id,
    greeting: "Fake greeting " + id,
    personality: "friendly",
    language: "en-US",
    widgetApiKey,
    widgetEnabled: true,
    widgetExternalCrmEnabled: crm,
  });
  rows.agent_configs = [
    agent(1, 10, keyA, true),
    agent(2, 20, keyB, true),
    agent(3, 30, keyPlain, false),
  ];
  rows.external_crm_configs = [crmConfig(1, 10, "a"), crmConfig(2, 20, "b")];
  // Phase 1C behavior is exercised through an explicitly enabled OTP policy.
  rows.widget_verification_policies = [otpPolicy(1), otpPolicy(2)];
  installService();
});

function otpPolicy(tenantId: number) {
  return {
    id: tenantId,
    tenantId,
    enabled: true,
    method: "sms_otp",
    dobFieldPath: null,
    dobFormat: null,
    version: 1,
    updatedByTenantUserId: null,
    createdAt: clock,
    updatedAt: clock,
  };
}
const OTP_POLICY = { tenantId: 1, version: 1, method: "sms_otp" as const, dobFieldPath: null, dobFormat: null };

async function post(route: string, body: any) {
  const res = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}
const start = (phone: string, apiKey = keyA) =>
  post("/widget/crm/verification/start", { apiKey, phone });
const verify = (challengeId: string, code: string, apiKey = keyA) =>
  post("/widget/crm/verification/verify", { apiKey, challengeId, code });
const selectOrder = (sessionToken: string, orderId: string, apiKey = keyA) =>
  post("/widget/crm/select-order", { apiKey, sessionToken, orderId });
const chat = (crmSessionToken: string | undefined, message: string, apiKey = keyA) =>
  post("/widget/chat", { apiKey, message, crmSessionToken });
const codeFor = (phone: string) => sent.filter((m) => m.phone === phone).at(-1)!.code;
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

async function challenge(phone = ALICE, apiKey = keyA) {
  const res = await start(phone, apiKey);
  assert.equal(res.status, 200, res.text);
  await settle();
  return res.json.challengeId as string;
}
async function verifiedToken(phone = ALICE, apiKey = keyA) {
  const id = await challenge(phone, apiKey);
  const res = await verify(id, codeFor(phone), apiKey);
  assert.equal(res.status, 200, res.text);
  return res.json.sessionToken as string;
}
async function orderSession(order = "22222") {
  const token = await verifiedToken();
  const res = await selectOrder(token, order);
  assert.equal(res.status, 200, res.text);
  return token;
}

const PRIVATE = ["Synthetic Alice", "Synthetic Carol", "Tenant B Person", "11111", "22222", "33333", "44444", "shipped-alpha", "pending-beta"];
const assertNoCustomerData = (text: string) => {
  for (const value of PRIVATE) assert.ok(!text.includes(value), `disclosed ${value}: ${text}`);
};

test("an embed key alone obtains no customer or order data; retired phone/order endpoints disclose nothing", async () => {
  const noSession = await chat(undefined, "What is the status of order 22222?");
  assert.equal(noSession.status, 403);
  assert.equal(noSession.json.crmAuthRequired, true);
  assertNoCustomerData(noSession.text);
  assert.equal((await selectOrder("", "22222")).status, 401);
  for (const route of ["/widget/crm/verify-phone", "/widget/crm/verify-order"]) {
    const res = await post(route, { apiKey: keyA, phone: ALICE, orderId: "22222" });
    assert.equal(res.status, 410);
    assert.ok(!res.json.sessionToken);
    assertNoCustomerData(res.text);
  }
  assert.equal(crmHits.length, 0, "no CRM lookup without verification");
  assert.equal(chatPrompts.length, 0);
});

test("a phone lookup is generic: same status/body for registered and unknown phones; no names or order IDs", async () => {
  const known = await start(ALICE);
  const unknown = await start(UNKNOWN);
  assert.equal(known.status, 200);
  assert.equal(unknown.status, known.status);
  const shape = (body: any) => ({ ...body, challengeId: typeof body.challengeId });
  assert.deepEqual(shape(unknown.json), shape(known.json));
  assertNoCustomerData(known.text);
  await settle();
  assert.deepEqual(sent.map((m) => m.phone), [ALICE], "codes only reach registered customers");
  assert.equal(rows.widget_verification_challenges.find((c) => c.phone === UNKNOWN).eligible, false);
  const malformed = await start("12");
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.error, "invalid_phone");
});

test("an order ID alone, or as a code or token, cannot establish identity", async () => {
  const id = await challenge();
  assert.equal((await verify(id, "22222")).status, 400);
  assert.equal((await selectOrder("22222", "22222")).status, 401);
  assert.equal((await chat("22222", "order 22222")).status, 403);
  assert.equal(rows.widget_customer_sessions?.length ?? 0, 0);
});

test("invalid, expired, replayed and mis-scoped challenges are rejected", async () => {
  const id = await challenge();
  const code = codeFor(ALICE);
  assert.equal((await verify(id, wrong(code))).status, 400);
  assert.equal((await verify("not-a-uuid", code)).status, 400);
  assert.equal((await verify(id, code, keyB)).status, 400, "other tenant's widget");
  assert.equal((await verify(id, code, keyPlain)).status, 403, "widget without CRM");
  const ok = await verify(id, code);
  assert.equal(ok.status, 200);
  assert.equal((await verify(id, code)).status, 400, "replay after consumption");

  const expiring = await challenge(CAROL);
  advance(5 * 60_000 + 1);
  assert.equal((await verify(expiring, codeFor(CAROL))).status, 400, "expired");
  assert.equal(rows.widget_customer_sessions.length, 1);
});

test("concurrent attempts cannot bypass a challenge: one session, bounded attempts", async () => {
  const id = await challenge();
  const code = codeFor(ALICE);
  const results = await Promise.all([
    ...Array.from({ length: 6 }, () => verify(id, code)),
    ...Array.from({ length: 6 }, () => verify(id, wrong(code))),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(rows.widget_customer_sessions.length, 1);
  assert.ok(rows.widget_verification_challenges[0].attempts <= MAX_ATTEMPTS);

  const brute = await challenge(CAROL);
  const guesses = await Promise.all(
    Array.from({ length: 20 }, (_, i) => verify(brute, String(i).padStart(6, "0"))),
  );
  const row = rows.widget_verification_challenges.find((c) => c.id === brute);
  assert.ok(row.attempts <= MAX_ATTEMPTS, `attempts ${row.attempts}`);
  assert.ok(guesses.filter((g) => g.status === 200).length <= 1);
  // Each code comparison is logged with its reason; lost updates would allow more.
  const compared = logs.filter(
    (l) => l.event === "widget_verification_failed" && l.challengeId === brute && l.reason === "mismatch",
  ).length + guesses.filter((g) => g.status === 200).length;
  assert.ok(compared <= MAX_ATTEMPTS, `codes compared: ${compared}`);
});

test("interleaved verifies against the data layer compare at most MAX_ATTEMPTS codes and consume once", async () => {
  // Same-tick calls interleave every database step, unlike sequential HTTP parsing.
  const service = createWidgetVerification({
    sender: { send: async (message) => void sent.push(message) },
    now: () => clock,
    schedule: (task) => void pending.push(task()),
  });
  const agent = { id: 1, userId: 10 };
  const policy = OTP_POLICY;
  const issue = async (phone: string) => {
    const started = await service.start({ agent, apiKey: keyA, phone, source: "127.0.0.1", policy });
    assert.ok(started.ok);
    await settle();
    return { challengeId: started.challengeId, code: codeFor(phone) };
  };
  const first = await issue(ALICE);
  const winners = await Promise.all(
    Array.from({ length: 10 }, () => service.verify({ agent, apiKey: keyA, policy, ...first })),
  );
  assert.equal(winners.filter((r) => r.ok).length, 1);
  assert.equal(rows.widget_customer_sessions.length, 1);

  const second = await issue(CAROL);
  resetLogs();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      service.verify({
        agent,
        apiKey: keyA,
        policy,
        challengeId: second.challengeId,
        code: wrong(String((Number(second.code) + i) % 1_000_000)),
      }),
    ),
  );
  const compared = logs.filter((l) => l.event === "widget_verification_failed" && l.reason === "mismatch").length;
  assert.ok(compared <= MAX_ATTEMPTS, `codes compared: ${compared}`);
  const row = rows.widget_verification_challenges.find((c) => c.id === second.challengeId);
  assert.ok(row.attempts <= MAX_ATTEMPTS);
});

test("attempt, resend and start limits are enforced per challenge, destination, source and tenant", async () => {
  const id = await challenge();
  const code = codeFor(ALICE);
  for (let i = 0; i < MAX_ATTEMPTS; i++)
    assert.equal((await verify(id, wrong(code))).status, 400);
  assert.equal((await verify(id, code)).status, 400, "locked after max attempts");

  const resendId = await challenge(CAROL);
  const resend = () => post("/widget/crm/verification/resend", { apiKey: keyA, challengeId: resendId });
  assert.equal((await resend()).status, 429, "resend interval");
  const firstCode = codeFor(CAROL);
  for (let i = 0; i < 3; i++) {
    advance(61_000);
    assert.equal((await resend()).status, 200);
    await settle();
  }
  advance(61_000);
  assert.equal((await resend()).status, 429, "resend cap");
  assert.equal(sent.filter((m) => m.phone === CAROL).length, 4);
  const latest = codeFor(CAROL);
  if (latest !== firstCode) assert.equal((await verify(resendId, firstCode)).status, 400, "superseded code");
  assert.equal((await verify(resendId, latest)).status, 200);

  resetDatabase();
  Object.assign(rows, {
    users: [{ id: 10 }, { id: 20 }],
    tenants: [{ id: 1, ownerId: 10, status: "active" }, { id: 2, ownerId: 20, status: "active" }],
    agent_configs: [
      { id: 1, userId: 10, widgetApiKey: keyA, widgetEnabled: true, widgetExternalCrmEnabled: true },
      { id: 2, userId: 20, widgetApiKey: keyB, widgetEnabled: true, widgetExternalCrmEnabled: true },
    ],
    external_crm_configs: [crmConfig(1, 10, "a"), crmConfig(2, 20, "b")],
    widget_verification_policies: [otpPolicy(1), otpPolicy(2)],
  });
  for (let i = 0; i < 3; i++) assert.equal((await start(ALICE)).status, 200);
  assert.equal((await start(ALICE)).status, 429, "destination limit");
  for (let i = 0; i < 7; i++) assert.equal((await start("80000000" + String(i).padStart(2, "0"))).status, 200);
  assert.equal((await start("8000000099")).status, 429, "source limit");
  advance(16 * 60_000);
  for (let i = 0; i < 200; i++)
    rows.widget_verification_challenges.push({
      id: "synthetic-" + i,
      tenantId: 1,
      destinationHash: "x" + i,
      sourceHash: "y" + i,
      createdAt: new Date(clock.getTime() - 1000),
    });
  assert.equal((await start(CAROL)).status, 429, "tenant limit");
  assert.equal((await start(ALICE, keyB)).status, 200, "other tenants unaffected");
  await settle();
});

test("verification failures are byte-identical regardless of cause", async () => {
  const id = await challenge();
  const code = codeFor(ALICE);
  const unknownId = await challenge(UNKNOWN);
  const failures = [
    await verify(id, wrong(code)),
    await verify("00000000-0000-4000-8000-000000000000", code),
    await verify(id, code, keyB),
    await verify(unknownId, code),
    await verify(id, "abc"),
  ];
  await verify(id, code);
  failures.push(await verify(id, code));
  advance(10 * 60_000);
  failures.push(await verify(unknownId, "123456"));
  for (const failure of failures) {
    assert.equal(failure.status, 400);
    assert.equal(failure.text, failures[0].text);
  }
  assertNoCustomerData(failures.map((f) => f.text).join());
});

test("a verified customer sees only their own records, revalidated each turn", async () => {
  const token = await verifiedToken();
  const verified = rows.widget_customer_sessions[0];
  assert.equal(verified.activeOrderId, null);
  assert.equal((await chat(token, "hello")).json.crmOrderRequired, true);
  const selected = await selectOrder(token, "22222");
  assert.equal(selected.status, 200);
  assert.match(selected.json.greeting, /Synthetic Alice.*22222/);

  aiBehavior.chatReply = "Fake authorized reply";
  const before = crmHits.length;
  const reply = await chat(token, "What is my order status?");
  assert.equal(reply.status, 200, reply.text);
  assert.equal(reply.json.reply, "Fake authorized reply");
  assert.ok(crmHits.length > before, "CRM re-queried for the turn");
  const prompt = JSON.stringify(chatPrompts.at(-1));
  assert.ok(prompt.includes("pending-beta"));
  for (const other of ["shipped-alpha", "carol-gamma", "tenant-b-delta", "Synthetic Carol"])
    assert.ok(!prompt.includes(other), `prompt leaked ${other}`);
  assert.ok(!reply.text.includes(token), "chat responses never echo the session credential");

  const switched = await chat(token, "What about order 11111?");
  assert.match(switched.json.reply, /11111/);
  assert.equal(verified.activeOrderId, "11111");
});

test("cross-customer and cross-tenant order and session use is denied", async () => {
  const token = await verifiedToken();
  for (const order of ["33333", "44444", "99999"]) {
    const res = await selectOrder(token, order);
    assert.equal(res.status, 404);
    assertNoCustomerData(res.text);
  }
  assert.equal((await selectOrder(token, "22222", keyB)).status, 401);
  assert.equal((await chat(token, "hi", keyB)).status, 403);
  await selectOrder(token, "22222");
  const otherOrder = await chat(token, "Tell me about order 33333");
  assert.equal(otherOrder.status, 200);
  assert.ok(!otherOrder.text.includes("carol-gamma") && !otherOrder.text.includes("Synthetic Carol"));
  const hits = crmHits.length;
  const otherPhone = await chat(token, `Show details for this number ${CAROL}`);
  assert.match(otherPhone.json.reply, /verify that number/);
  assert.ok(!crmHits.slice(hits).some((h) => h.phone === CAROL), "no lookup for unverified phone");
  assert.equal(rows.widget_customer_sessions[0].phone, ALICE);

  const tokenB = await verifiedToken(ALICE, keyB);
  assert.equal((await selectOrder(tokenB, "22222", keyB)).status, 404, "same phone, other tenant's CRM");
  assert.equal((await selectOrder(tokenB, "44444", keyB)).status, 200);
});

test("tampered, forged, expired and rebound session tokens are denied", async () => {
  const token = await orderSession();
  aiBehavior.chatReply = "Fake authorized reply";
  assert.equal((await chat(token, "hi")).status, 200);
  const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  const forged =
    Buffer.from(JSON.stringify({ userId: 10, phone: ALICE, activeOrderId: "22222", expiresAt: Date.now() * 2 })).toString("base64url") +
    "." +
    createHmac("sha256", process.env.JWT_SECRET!).update("x").digest("base64url");
  for (const bad of [flipped, token + "x", forged, "", "null"])
    assert.equal((await chat(bad, "hi")).status, 403);

  rows.agent_configs[0].widgetApiKey = keyA2;
  assert.equal((await chat(token, "hi", keyA2)).status, 403, "rotated widget key");
  rows.agent_configs[0].widgetApiKey = keyA;

  rows.tenants[0].status = "suspended";
  const suspended = await chat(token, "hi");
  assert.ok(suspended.status === 403 || suspended.json.activeOrderId === null, "suspended tenant");
  assertNoCustomerData(suspended.text);
  assert.ok(!JSON.stringify(chatPrompts.at(-1)).includes("pending-beta"), "no CRM context when suspended");
  rows.tenants[0].status = "active";
  assert.equal((await chat(token, "hi")).status, 200);

  advance(30 * 60_000 + 1);
  assert.equal((await chat(token, "hi")).status, 403, "expired");
});

test("revoked sessions and revoked CRM ownership are denied", async () => {
  const token = await orderSession();
  aiBehavior.chatReply = "Fake authorized reply";
  crmData.a[ALICE].orders = crmData.a[ALICE].orders.filter((o: any) => o.orderId !== "22222");
  const gone = await chat(token, "status?");
  assert.equal(gone.status, 403);
  assert.equal(gone.json.crmOrderRequired, true);
  assertNoCustomerData(gone.text);
  resetCrm();
  assert.equal((await chat(token, "status?")).status, 200);
  assert.equal((await post("/widget/crm/session/end", { apiKey: keyA, sessionToken: token })).status, 200);
  assert.equal(rows.widget_customer_sessions[0].state, "revoked");
  assert.equal((await chat(token, "status?")).status, 403);
  assert.equal((await selectOrder(token, "22222")).status, 401);
});

test("no sender or no verification key fails closed with no lookups or stored state", async () => {
  installService(false);
  const res = await start(ALICE);
  assert.equal(res.status, 403, "an OTP policy without a sender is never active");
  assert.equal(res.json.error, "customer_access_disabled");
  assert.equal(crmHits.length, 0);
  assert.equal(rows.widget_verification_challenges?.length ?? 0, 0);
  const general = await chat(undefined, "What is the status of order 22222?");
  assert.equal(general.status, 200, "general chat only");
  assertNoCustomerData(general.text);
  assert.equal(crmHits.length, 0);
  assert.ok(!JSON.stringify(chatPrompts).includes("pending-beta"));

  installService(true);
  const original = process.env.WIDGET_VERIFICATION_KEY;
  try {
    for (const value of ["", "not-base64", Buffer.alloc(8).toString("base64")]) {
      process.env.WIDGET_VERIFICATION_KEY = value;
      assert.equal((await start(ALICE)).status, 403);
    }
  } finally {
    process.env.WIDGET_VERIFICATION_KEY = original;
  }
  assert.equal(rows.widget_verification_challenges?.length ?? 0, 0);
  assert.equal(crmHits.length, 0);
});

test("logs never contain codes, tokens, phones, names, orders or transcripts", async () => {
  aiBehavior.chatReply = "Synthetic reply about your parcel";
  const id = await challenge();
  const code = codeFor(ALICE);
  await verify(id, wrong(code));
  const token = (await verify(id, code)).json.sessionToken;
  await selectOrder(token, "22222");
  await chat(token, "where is my synthetic parcel?");
  await start(UNKNOWN);
  await settle();
  const out = emitted();
  assert.ok(out.includes("widget_verification_verified"));
  for (const leaked of [code, wrong(code), token, ALICE, UNKNOWN, ...PRIVATE, "synthetic parcel", "Synthetic reply"])
    assert.ok(!out.includes(leaked), `log output leaked: ${leaked}`);
});

test("widget initialization, non-CRM chat and the served loader script are unchanged in behavior", async () => {
  const config = await fetch(base + `/widget/config/${keyA}`).then((r) => r.json());
  assert.deepEqual(Object.keys(config).sort(), [
    "agentName", "crmAuthRequired", "crmConnected", "crmName", "crmVerification", "greeting", "language", "personality", "voiceEnabled", "widgetExternalCrmEnabled",
  ]);
  assert.equal(config.crmAuthRequired, true);
  assert.deepEqual(config.crmVerification, { method: "sms_otp", factor: "code", length: 6 });
  aiBehavior.chatReply = "Fake public reply";
  const plain = await chat(undefined, "Tell me about your services", keyPlain);
  assert.equal(plain.status, 200);
  assert.equal(plain.json.reply, "Fake public reply");
  const loader = await fetch(base + `/widget/loader.js?key=${keyA}`).then((r) => r.text());
  assert.doesNotThrow(() => new Script(loader));
  assert.ok(loader.includes("verification/start") && !loader.includes("verify-phone"));
});

test("verification migration and snapshot are additive", async () => {
  const directory = path.resolve("../../lib/db/drizzle");
  const previous = JSON.parse(await readFile(path.join(directory, "meta/0002_snapshot.json"), "utf8"));
  const next = JSON.parse(await readFile(path.join(directory, "meta/0003_snapshot.json"), "utf8"));
  const added = ["public.widget_verification_challenges", "public.widget_customer_sessions"];
  const tables = { ...next.tables };
  for (const name of added) {
    assert.ok(tables[name]);
    delete tables[name];
  }
  assert.deepEqual(tables, previous.tables);
  assert.equal(next.prevId, previous.id);
  const migration = await readFile(path.join(directory, "0003_widget_customer_verification.sql"), "utf8");
  assert.ok(!/\b(DROP|ALTER|INSERT|UPDATE|DELETE)\b/i.test(migration.replace(/ON DELETE CASCADE/g, "")));
  const journal = JSON.parse(await readFile(path.join(directory, "meta/_journal.json"), "utf8"));
  assert.equal(journal.entries[3].tag, "0003_widget_customer_verification");
});

import "./postgres-widget-verification.test";
