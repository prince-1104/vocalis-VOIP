// Phase 1B regression tests. Every assertion inspects lines emitted by the real
// Pino logger (see capture-logger.ts); all customer data and credentials are synthetic.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { rows, resetDatabase, db } from "./fake-db";
import { logs, emitted, resetLogs } from "./capture-logger";
import { logger } from "../src/lib/logger";
import { providerHttpError, redactForLog } from "../src/lib/log-redaction";
import { createHttpLogger } from "../src/lib/http-logger";
import { safeErrorHandler, installProcessErrorHandlers } from "../src/lib/error-handler";
import agentsRouter from "../src/routes/agents";
import { openCredential } from "../src/lib/credential-crypto";
import callsRouter from "../src/routes/calls";
import { fetchExternalCrmData, invalidateExternalCrmConfigCache } from "../src/lib/external-crm-lookup";
import { startWebhookDispatcher } from "../src/lib/webhook-dispatcher";
import { crmEventBus } from "../src/lib/crm-event-bus";
import { createUsageScope } from "../src/lib/billing/usage-ledger";
import { listenCrmFixture } from "./fake-crm-http";

after(() => {
  for (const timer of (globalThis as any).__dialogTestIntervals) clearInterval(timer);
});

const PHONE = "+15550100123";
const PHONE_DIGITS = "5550100123";
const EMAIL = "jane.synthetic@example.test";
const FAKE_KEY = "sk-test-" + "q".repeat(32);
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJlLXN5bnRoZXRpYw";
const TRANSCRIPT = "Synthetic caller asks about the overdue invoice for Jane Synthetic";
const DB_URI = "postgres://dialog_user:fake-db-password@db.internal.test:5432/dialog";

function assertNoLeak(values: string[]) {
  const out = emitted();
  assert.ok(out.length > 0, "expected real logger output");
  for (const value of values) assert.ok(!out.includes(value), `log output leaked: ${value}`);
}
const last = (msg: string) => {
  const entry = [...logs].reverse().find((l) => l.msg === msg);
  assert.ok(entry, `missing log entry: ${msg}`);
  return entry!;
};
const delay = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for test effect");
}
async function serve(app: any, t: any) {
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
async function serveCrm(app: any, t: any) {
  const { server, base } = await listenCrmFixture(app);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return base;
}
const fakeAuth = (req: any, _res: any, next: any) => {
  req.userId = 10;
  req.tenantId = 1;
  req.isSuperadmin = true;
  next();
};

beforeEach(() => {
  resetDatabase();
  resetLogs();
});

test("nested and array credential fields are redacted in emitted lines", () => {
  logger.info(
    {
      event: "fixture_nested",
      callLogId: 7,
      agent: {
        twilioAuthToken: "fake-twilio-token-123456",
        telephonyApiSecret: "fake-telephony-secret",
        nested: [{ password: "fake-password-1", apiKey: FAKE_KEY }, { authorization: `Bearer ${FAKE_JWT}` }],
      },
      headers: { cookie: "sid=fake-cookie-value" },
      databaseUrl: DB_URI,
      mediaCredential: "fake-media-credential",
    },
    "Nested fixture",
  );
  const entry = last("Nested fixture");
  assert.equal(entry.event, "fixture_nested");
  assert.equal(entry.callLogId, 7);
  assert.equal(entry.agent.twilioAuthToken, "[REDACTED]");
  assert.equal(entry.agent.nested[0].password, "[REDACTED]");
  assertNoLeak([
    "fake-twilio-token-123456",
    "fake-telephony-secret",
    "fake-password-1",
    FAKE_KEY,
    FAKE_JWT,
    "fake-cookie-value",
    "fake-db-password",
    "fake-media-credential",
  ]);
});

test("phones, emails, tokens and secret URLs are scrubbed from free-text messages and interpolation", () => {
  logger.warn(
    `Caller ${PHONE} (alt +1 (555) 010-0123) emailed ${EMAIL} with ${FAKE_JWT} via ` +
      `https://user:fake-pass@crm.test/x?token=abc123secret&phone=${encodeURIComponent(PHONE)} ` +
      `and ${DB_URI} Authorization: Bearer ${FAKE_KEY}`,
  );
  logger.info("Dialing %s for %s", PHONE, EMAIL);
  logger.info({ note: `call me at ${PHONE}` }, `note for ${EMAIL}`);
  assert.ok(logs.some((l) => typeof l.msg === "string" && l.msg.includes("[REDACTED_PHONE]")));
  assert.ok(logs.some((l) => typeof l.msg === "string" && l.msg.includes("[REDACTED_EMAIL]")));
  assertNoLeak([PHONE, PHONE_DIGITS, "010-0123", EMAIL, FAKE_JWT, "fake-pass", "abc123secret", "fake-db-password", FAKE_KEY]);
});

test("transcripts, messages, prompts, CRM payloads and audio never reach standard log output", () => {
  logger.info(
    {
      event: "fixture_turn",
      callLogId: 9,
      transcript: TRANSCRIPT,
      liveTranscript: [{ role: "user", content: TRANSCRIPT }],
      messages: [{ role: "user", content: TRANSCRIPT }],
      prompt: `System: customer Jane Synthetic. ${TRANSCRIPT}`,
      rawData: { orders: ["ORD-SYN-991"], address: "12 Synthetic Lane" },
      customerName: "Jane Synthetic",
      greeting: "Hello Jane Synthetic",
      audio: Buffer.from("fake-audio-bytes"),
      media: { payload: Buffer.from("fake-mulaw-frame").toString("base64") },
      body: { phone: PHONE, email: EMAIL },
    },
    "Turn fixture",
  );
  const entry = last("Turn fixture");
  assert.equal(entry.callLogId, 9);
  assertNoLeak([
    TRANSCRIPT,
    "Jane Synthetic",
    "ORD-SYN-991",
    "12 Synthetic Lane",
    "fake-audio-bytes",
    Buffer.from("fake-mulaw-frame").toString("base64"),
    PHONE,
    EMAIL,
  ]);
});

test("error objects expose only allowlisted fields: no headers, bodies, params or secret URLs", () => {
  class FakeAPIError extends Error {
    status = 401;
    code = "invalid_api_key";
    headers = { authorization: `Bearer ${FAKE_KEY}`, "openai-organization": "org-synthetic" };
    error = { message: `echo ${TRANSCRIPT}` };
    request_id = "req_synthetic_1";
    constructor() {
      super(`401 Incorrect API key provided: ${FAKE_KEY}. Prompt was: ${TRANSCRIPT}`);
      this.name = "APIError";
    }
  }
  const axiosLike = Object.assign(new Error("Request failed with status code 500"), {
    name: "AxiosError",
    code: "ERR_BAD_RESPONSE",
    config: {
      url: `https://crm.test/lookup?phone=${PHONE}`,
      headers: { Authorization: "Bearer fake-crm-token" },
      data: JSON.stringify({ phone: PHONE }),
    },
    response: { status: 500, data: { customer: "Jane Synthetic" } },
  });
  const pgError = Object.assign(new Error('duplicate key value violates unique constraint "contacts_phone_key"'), {
    code: "23505",
    detail: `Key (phone)=(${PHONE}) already exists.`,
    constraint: "contacts_phone_key",
    table: "contacts",
  });
  const drizzleError = new Error(
    `Failed query: insert into "contacts" ("phone", "email") values ($1, $2)\nparams: ${PHONE},${EMAIL}`,
    { cause: pgError },
  );
  const fetchError = new TypeError("fetch failed", {
    cause: Object.assign(new Error(`connect ECONNREFUSED ${DB_URI}`), { code: "ECONNREFUSED", syscall: "connect" }),
  });
  const provider = providerHttpError(
    "Sarvam STT",
    400,
    JSON.stringify({ error: { code: "invalid_audio", message: `echo ${TRANSCRIPT}` } }),
  );

  logger.error({ err: new FakeAPIError(), event: "fixture_openai" }, "OpenAI fixture");
  logger.error({ err: axiosLike }, "Axios fixture");
  logger.error({ err: pgError }, "Pg fixture");
  logger.error(drizzleError);
  logger.error({ err: fetchError }, "Fetch fixture");
  logger.error({ err: provider }, "Provider fixture");

  const openaiEntry = last("OpenAI fixture");
  assert.equal(openaiEntry.err.status, 401);
  assert.equal(openaiEntry.err.code, "invalid_api_key");
  assert.equal(openaiEntry.err.headers, undefined);
  assert.equal(openaiEntry.err.error, undefined);
  assert.equal(openaiEntry.err.message, "HTTP 401 error (message omitted)");
  assert.ok(typeof openaiEntry.err.stack === "string" && openaiEntry.err.stack.includes(" at "));

  const axiosEntry = last("Axios fixture");
  assert.equal(axiosEntry.err.code, "ERR_BAD_RESPONSE");
  assert.equal(axiosEntry.err.config, undefined);
  assert.equal(axiosEntry.err.response, undefined);

  const pgEntry = last("Pg fixture");
  assert.equal(pgEntry.err.code, "23505");
  assert.equal(pgEntry.err.constraint, "contacts_phone_key");
  assert.equal(pgEntry.err.detail, undefined);

  const drizzleEntry = last("Failed query (details omitted)");
  assert.equal(drizzleEntry.err.cause.code, "23505");

  assert.equal(last("Fetch fixture").err.cause.code, "ECONNREFUSED");
  const providerEntry = last("Provider fixture");
  assert.equal(providerEntry.err.message, "Sarvam STT API error 400");
  assert.equal(providerEntry.err.providerCode, "invalid_audio");

  assertNoLeak([
    FAKE_KEY,
    TRANSCRIPT,
    "org-synthetic",
    "fake-crm-token",
    "Jane Synthetic",
    PHONE,
    PHONE_DIGITS,
    EMAIL,
    "fake-db-password",
    "values ($1",
  ]);
});

test("circular, malformed and oversized values neither crash logging nor fall back to raw output", () => {
  const circular: any = { id: 1, label: "loop" };
  circular.self = circular;
  circular.list = [circular];
  const throwing = {
    get explodes() {
      throw new Error("getter boom");
    },
    ok: 1,
  };
  let deep: any = { leaf: FAKE_KEY };
  for (let i = 0; i < 60; i++) deep = { next: deep };
  const proxy = new Proxy(
    { apiKey: FAKE_KEY },
    {
      ownKeys() {
        throw new Error("proxy boom");
      },
    },
  );
  const withToJson = { id: 3, toJSON: () => ({ leaked: FAKE_KEY }) };

  assert.doesNotThrow(() =>
    logger.info(
      {
        event: "fixture_malformed",
        circular,
        throwing,
        big: "x".repeat(200_000) + PHONE,
        deep,
        bigint: 10n,
        sym: Symbol("s"),
        fn: () => FAKE_KEY,
        map: new Map([["phone", PHONE]]),
        proxy,
        withToJson,
        invalidDate: new Date("invalid"),
      },
      "Malformed fixture",
    ),
  );
  const entry = last("Malformed fixture");
  assert.equal(entry.event, "fixture_malformed");
  assert.equal(entry.circular.self, "[Circular]");
  assert.equal(entry.throwing.explodes, "[Unreadable]");
  assert.equal(entry.bigint, "10");
  assert.equal(entry.proxy, "[Unserializable]");
  assert.ok(entry.big.length < 2000);
  assert.equal(redactForLog(proxy), "[Unserializable]");
  assertNoLeak([FAKE_KEY, PHONE]);
});

test("redaction never mutates the original business objects", () => {
  const err = Object.assign(new Error(`failed for ${PHONE}`), { headers: { authorization: "Bearer fake-x" } });
  const business = {
    phone: PHONE,
    transcript: TRANSCRIPT,
    nested: { apiKey: FAKE_KEY, list: [EMAIL, { password: "fake-password-2" }] },
  };
  const snapshot = structuredClone(business);
  logger.info({ ...business, err }, "Mutation fixture");
  logger.info(business, "Mutation fixture 2");
  redactForLog(business);
  assert.deepEqual(business, snapshot);
  assert.equal(err.message, `failed for ${PHONE}`);
  assert.deepEqual(err.headers, { authorization: "Bearer fake-x" });
});

test("safe operational metadata and correlation IDs survive redaction", () => {
  const metadata = {
    event: "call_turn_latency",
    callLogId: 77,
    reqId: "req-synthetic-1",
    correlationId: "corr-abc-123",
    sessionId: "sess-opaque-1",
    provider: "sarvam",
    latencyMs: 812,
    code: "E_TIMEOUT",
    status: 504,
    inputTokens: 1200,
    transcriptLength: 54,
    hasName: true,
    streamSid: "MZ" + "a".repeat(32),
  };
  logger.info(metadata, "Latency fixture");
  const entry = last("Latency fixture");
  for (const [key, value] of Object.entries(metadata)) assert.deepEqual(entry[key], value, key);
  assert.equal(typeof entry.time, "number");
});

test("PUT /agents logs field names only, never credentials or customer values", async (t) => {
  rows.agent_configs = [{ userId: 10, agentName: "Old", language: "en-US", aiModel: "gpt-4o-mini" }];
  const app = express();
  app.use(express.json());
  app.use(fakeAuth);
  app.use(agentsRouter);
  const base = await serve(app, t);
  const res = await fetch(base + "/agents", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentName: "Synthetic Agent",
      twilioAuthToken: "fake-twilio-auth-token-xyz",
      telephonyApiKey: "fake-telephony-key-xyz",
      telephonyApiSecret: "fake-telephony-secret-xyz",
      phoneNumber: PHONE,
      greeting: "Hello Jane Synthetic",
      unexpectedField: "fake-unexpected-value",
    }),
  });
  assert.equal(res.status, 200);
  // Phase 1G: stored credentials are encrypted and never echoed, even to superadmins.
  const body = await res.json();
  assert.equal(body.twilioAuthToken, "***");
  assert.equal(body.phoneNumber, PHONE);
  assert.match(rows.agent_configs[0].twilioAuthToken, /^enc:v1:/);
  assert.equal(openCredential("twilioAuthToken", 10, rows.agent_configs[0].twilioAuthToken), "fake-twilio-auth-token-xyz");

  const entry = last("Agent configuration update requested");
  assert.equal(entry.event, "agent_configuration_update_requested");
  assert.equal(entry.userId, 10);
  assert.ok(entry.fields.includes("twilioAuthToken"));
  assert.ok(!entry.fields.includes("unexpectedField"));
  assertNoLeak([
    "fake-twilio-auth-token-xyz",
    "fake-telephony-key-xyz",
    "fake-telephony-secret-xyz",
    PHONE,
    "Jane Synthetic",
    "fake-unexpected-value",
  ]);
});

test("Express error handler and request logging sanitize malformed bodies, thrown errors and query strings", async (t) => {
  const app = express();
  app.use(createHttpLogger());
  app.use(express.json());
  app.post("/echo", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/boom", () => {
    throw new Error(`lookup failed for ${PHONE} / ${EMAIL}`);
  });
  app.use(safeErrorHandler());
  const base = await serve(app, t);

  const malformed = await fetch(base + "/echo", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${FAKE_JWT}` },
    body: `synthetic secret words ${PHONE} ${EMAIL}`,
  });
  assert.equal(malformed.status, 400);
  assert.equal(await malformed.text(), "Bad Request");

  const boom = await fetch(base + `/boom?token=fake-query-token&phone=${encodeURIComponent(PHONE)}`);
  assert.equal(boom.status, 500);
  assert.equal(await boom.text(), "Internal Server Error");
  await until(() => logs.filter((l) => l.msg === "request completed" || l.msg === "request errored").length >= 2);

  const failures = logs.filter((l) => l.event === "http_request_failed");
  assert.equal(failures.length, 2);
  assert.equal(failures[0].status, 400);
  assert.equal(failures[0].err.message, "HTTP 400 error (message omitted)");
  assert.equal(failures[1].status, 500);
  assert.equal(failures[1].path, "/boom");
  assert.ok(logs.every((l) => !l.req || !String(l.req.url).includes("?")));
  assertNoLeak(["synthetic secret words", PHONE, PHONE_DIGITS, EMAIL, FAKE_JWT, "fake-query-token"]);
});

test("external CRM lookup failures log origin/path only, never phone, query secrets or CRM credentials", async (t) => {
  const received: string[] = [];
  const crm = express();
  crm.get("/lookup", (req, res) => {
    received.push(String(req.query.phone));
    res.status(500).json({ customer: "Jane Synthetic", phone: PHONE });
  });
  const base = await serveCrm(crm, t);
  const crmConfig = {
    id: 1,
    userId: 10,
    isEnabled: true,
    lookupUrl: `${base}/lookup?apiKey=${FAKE_KEY}`,
    httpMethod: "GET",
    authType: "bearer",
    authValue: "fake-crm-bearer-secret",
    phoneParamName: "phone",
    phoneParamLocation: "query",
    timeoutMs: 2000,
    cacheTtlSeconds: 1,
    maxContextChars: 2000,
    responseMapping: null,
    useRawResponse: false,
  };
  rows.external_crm_configs = [crmConfig];
  invalidateExternalCrmConfigCache(10);
  assert.equal(await fetchExternalCrmData(10, PHONE), null);
  // The CRM provider still receives the real phone number.
  assert.deepEqual(received, [PHONE]);
  assert.equal(last("External CRM lookup returned non-OK status").lookupUrl, `${base}/lookup`);

  crmConfig.lookupUrl = `http://127.0.0.1:1/lookup?token=${FAKE_KEY}`;
  invalidateExternalCrmConfigCache(10);
  assert.equal(await fetchExternalCrmData(10, PHONE), null);
  const rejected = last("External CRM destination rejected");
  assert.equal(rejected.userId, 10);
  assert.equal(rejected.reason, "scheme");

  // A transport failure (nothing listening on the port) logs a typed error.
  const closed = await listenCrmFixture(crm);
  closed.server.close();
  await once(closed.server, "close");
  crmConfig.lookupUrl = `${closed.base}/lookup?token=${FAKE_KEY}`;
  invalidateExternalCrmConfigCache(10);
  assert.equal(await fetchExternalCrmData(10, PHONE), null);
  const failure = last("External CRM lookup failed");
  assert.equal(failure.userId, 10);
  assert.equal(failure.err.type, "OutboundRequestFailed");
  assert.equal(failure.err.code, "OUTBOUND_NETWORK");
  assertNoLeak([PHONE, encodeURIComponent(PHONE), PHONE_DIGITS, FAKE_KEY, "fake-crm-bearer-secret", "Jane Synthetic"]);
});

test("background jobs: webhook retries, cost logging and process handlers emit sanitized errors", async (t) => {
  const hookBodies: any[] = [];
  const hook = express();
  hook.use(express.json());
  hook.post("/hook", (req, res) => {
    hookBodies.push(req.body);
    res.status(500).send(`echo ${JSON.stringify(req.body)}`);
  });
  const base = await serveCrm(hook, t);
  rows.crm_api_keys = [
    {
      id: 1,
      userId: 10,
      tenantId: 1,
      isActive: true,
      webhookUrl: `${base}/hook?secret=fake-hook-query-secret`,
      webhookSecret: "fake-webhook-signing-secret",
    },
  ];
  rows.webhook_deliveries = [];
  startWebhookDispatcher();
  crmEventBus.emitCallEvent({
    type: "call.turn",
    callId: 1,
    userId: 10,
    callSid: "CA" + "c".repeat(32),
    data: { role: "user", content: TRANSCRIPT, phone: PHONE },
    metadata: { customerEmail: EMAIL },
    timestamp: new Date().toISOString(),
  } as any);
  await until(() => logs.some((l) => l.msg === "Webhook delivery failed, scheduled retry"));
  const retry = last("Webhook delivery failed, scheduled retry");
  assert.equal(retry.status, 500);
  assert.equal(retry.callId, 1);
  // The tenant's CRM webhook still receives the complete authorized payload.
  assert.equal(hookBodies[0].data.content, TRANSCRIPT);
  assert.equal(hookBodies[0].data.phone, PHONE);

  (rows.tenants ||= []).push({ id: 9010, ownerId: 9010, name: "Synthetic Tenant" });
  const originalInsert = db.insert;
  db.insert = () => {
    throw Object.assign(new Error("insert failed"), { code: "23505", detail: `Key (phone)=(${PHONE}) exists` });
  };
  try {
    const usage = createUsageScope({ userId: 9010, source: "widget-chat", keyPrefix: "pii-test" });
    usage.record({ category: "llm", provider: "openai", model: "gpt-4o-mini", measurement: "actual", unit: "tokens", quantity: 10, inputTokens: 5, outputTokens: 5 });
    await usage.flush();
  } finally {
    db.insert = originalInsert;
  }
  const cost = last("Usage recording failed");
  assert.equal(cost.source, "widget-chat");
  assert.equal(cost.category, "llm");
  assert.equal(cost.err.code, "23505");

  const proc = new EventEmitter();
  const exits: number[] = [];
  installProcessErrorHandlers(proc, (code) => exits.push(code));
  proc.emit(
    "unhandledRejection",
    Object.assign(new Error(`unhandled for ${EMAIL} via ${DB_URI}`), { config: { headers: { authorization: `Bearer ${FAKE_KEY}` } } }),
  );
  proc.emit("uncaughtException", new Error(`crash with ${PHONE}`));
  assert.deepEqual(exits, [1, 1]);
  assert.equal(last("Unhandled promise rejection").level, 60);
  assert.equal(last("Uncaught exception").event, "uncaught_exception");

  assertNoLeak([
    TRANSCRIPT,
    PHONE,
    PHONE_DIGITS,
    EMAIL,
    "fake-hook-query-secret",
    "fake-webhook-signing-secret",
    FAKE_KEY,
    "fake-db-password",
  ]);
});

test("authorized dashboard call details keep full caller phone and transcript; request logs do not", async (t) => {
  const liveTranscript = [
    { role: "user", content: TRANSCRIPT, timestamp: new Date().toISOString() },
    { role: "assistant", content: "Synthetic agent reply", timestamp: new Date().toISOString() },
  ];
  rows.call_logs = [
    {
      id: 1,
      userId: 10,
      phone: PHONE,
      transcript: `Caller: ${TRANSCRIPT}`,
      liveTranscript,
      direction: "inbound",
      startedAt: new Date(),
      contactId: null,
    },
  ];
  const app = express();
  app.use(createHttpLogger());
  app.use(fakeAuth);
  app.use(callsRouter);
  const base = await serve(app, t);
  const res = await fetch(base + `/calls/1?phone=${encodeURIComponent(PHONE)}`);
  assert.equal(res.status, 200);
  const call = await res.json();
  assert.equal(call.phone, PHONE);
  assert.equal(call.transcript, `Caller: ${TRANSCRIPT}`);
  assert.deepEqual(call.liveTranscript, liveTranscript);
  await until(() => logs.some((l) => l.msg === "request completed"));
  const completed = last("request completed");
  assert.equal(completed.req.url, "/calls/1");
  assert.equal(completed.res.statusCode, 200);
  assertNoLeak([PHONE, encodeURIComponent(PHONE), PHONE_DIGITS, TRANSCRIPT]);
});

test("server source has no direct console logging outside embedded browser scripts", async () => {
  // The runner executes from the API workspace root; bundles live in a temp dir.
  const srcRoot = path.resolve(process.cwd(), "src");
  const allowed = new Set([
    `res.status(400).type("application/javascript").send("console.error('Dialog widget: missing key parameter');");`,
    "console.error('[widget/voice] Connection error:', err);",
    "console.error('[widget/voice] Device error:', err);",
    "console.error('[widget/voice] Setup error:', err);",
  ]);
  const offenders: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts")) {
        const lines = (await readFile(full, "utf8")).split(/\r?\n/);
        lines.forEach((line, index) => {
          if (/console\.(log|error|warn|info|debug)\(/.test(line) && !allowed.has(line.trim()))
            offenders.push(`${path.relative(srcRoot, full)}:${index + 1}`);
        });
      }
    }
  }
  await walk(srcRoot);
  assert.deepEqual(offenders, []);
});
