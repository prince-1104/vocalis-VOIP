import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import twilio from "twilio";
import { rows, resetDatabase, writes } from "./fake-db";
import { logs, emitted, resetLogs } from "./capture-logger";
import { aiCalls } from "./fake-ai";
import { createHttpLogger } from "../src/lib/http-logger";
import { safeErrorHandler } from "../src/lib/error-handler";
import { resolveUser, requireRole } from "../src/middleware/auth";
import twilioRouter, { completeCallLog } from "../src/routes/twilio";
import crmRouter from "../src/routes/crm";
import dialRouter from "../src/routes/dial";
import { crmEventBus } from "../src/lib/crm-event-bus";
import { executeTransfer } from "../src/lib/transfer-manager";
import { releaseTransferSlot, reserveTransferSlot, transferCallbackUrls } from "../src/lib/transfer-slots";

after(() => {
  for (const timer of (globalThis as any).__dialogTestIntervals) clearInterval(timer);
});

const sid = (prefix: string, value: string) => prefix + value.repeat(32);
const ORIGIN = "https://dialog.test";
const ACCOUNT_A = sid("AC", "a"), ACCOUNT_B = sid("AC", "b");
const TOKEN_A = "fake-twilio-auth-token-tenant-a", TOKEN_B = "fake-twilio-auth-token-tenant-b";
const CALL_A = sid("CA", "a"), CALL_B = sid("CA", "b"), CALL_C = sid("CA", "c"), CALL_D = sid("CA", "d");
const CALLER = "+15550000009", AGENT_PHONE = "+15550001111";
const CRM_KEY_B = "dk_live_" + "b".repeat(64);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const signatures: string[] = [];
const events: any[] = [];
const captureEvent = (event: any) => events.push(event);
crmEventBus.on("call-event", captureEvent);
after(() => crmEventBus.off("call-event", captureEvent));
const ended = (callId: number) => events.filter((e) => e.type === "call.ended" && e.callId === callId).length;

beforeEach(() => {
  resetDatabase();
  resetLogs();
  aiCalls.length = 0;
  events.length = 0;
  rows.users = [{ id: 10 }, { id: 20 }];
  rows.tenants = [
    { id: 1, ownerId: 10, status: "active", slug: "a", telephonyType: "TWILIO", commissionPct: "0" },
    { id: 2, ownerId: 20, status: "active", slug: "b", telephonyType: "TWILIO", commissionPct: "0" },
  ];
  rows.agent_configs = [
    { userId: 10, twilioAccountSid: ACCOUNT_A, twilioAuthToken: TOKEN_A, phoneNumber: "+15550000001", language: "en-US", aiModel: "gpt-4o-mini", voice: "nova" },
    { userId: 20, twilioAccountSid: ACCOUNT_B, twilioAuthToken: TOKEN_B, phoneNumber: "+15550000002", language: "en-US", aiModel: "gpt-4o-mini", voice: "nova" },
  ];
  const call = (id: number, userId: number, callSid: string | null, extra = {}) => ({
    id, userId, callSid, direction: "outbound", phone: CALLER, aiModel: "gpt-4o-mini",
    endedAt: null, startedAt: new Date(), liveTranscript: [], ...extra,
  });
  rows.call_logs = [
    call(1, 10, CALL_A, { campaignId: 5, contactId: 7 }),
    call(2, 20, CALL_B),
    call(3, 10, CALL_C, { direction: "inbound" }),
    call(4, 10, null),
  ];
  rows.crm_agents = [
    { id: 1, userId: 10, crmAgentId: "agent-a", name: "Fake agent", phone: AGENT_PHONE, isAvailable: true, maxConcurrentCalls: 3, currentCalls: 0 },
  ];
  rows.campaigns = [{ id: 5, userId: 10, status: "paused", isAutomatic: false, maxRetries: 2, retryIntervalMinutes: 10 }];
  rows.campaign_contacts = [{ id: 1, campaignId: 5, contactId: 7, attempts: 1, status: "calling", nextAttemptAt: null, callLogId: 1 }];
  rows.crm_api_keys = [{ id: 2, keyHash: hash(CRM_KEY_B), userId: 20, tenantId: 2, scopes: ["*"], isActive: true }];
});

async function harness(t: any) {
  // Mirrors app.ts mount order for the routers under test.
  const app = express();
  app.use(createHttpLogger());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/api", twilioRouter);
  app.use("/api", crmRouter);
  app.use("/api", resolveUser);
  app.use("/api", requireRole("admin"), dialRouter);
  app.use(safeErrorHandler());
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as any).port as number;
  return function post(
    urlPath: string,
    body: Record<string, string>,
    options: { token?: string; signUrl?: string; signBody?: Record<string, string>; signature?: string | null; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; text: string }> {
    let signature = options.signature;
    if (signature === undefined) {
      signature = twilio.getExpectedTwilioSignature(
        options.token ?? TOKEN_A,
        options.signUrl ?? ORIGIN + urlPath,
        options.signBody ?? body,
      );
      signatures.push(signature);
    }
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: urlPath,
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...(signature ? { "x-twilio-signature": signature } : {}),
            ...options.headers,
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, text }));
        },
      );
      req.on("error", reject);
      req.end(new URLSearchParams(body).toString());
    });
  };
}

const statusBody = (callSid = CALL_C, status = "completed", duration = "42", account = ACCOUNT_A) => ({
  AccountSid: account, CallSid: callSid, CallStatus: status, CallDuration: duration, To: CALLER, From: "+15550000001",
});
const rejections = () => logs.filter((l) => l.event === "twilio_webhook_rejected").map((l) => l.reason);

test("signed status callbacks are accepted; missing, invalid, cross-URL and tampered signatures are rejected before any write", async (t) => {
  const post = await harness(t);
  const path3 = "/api/twilio/status?callLogId=3";
  for (const attempt of [
    () => post(path3, statusBody(), { signature: null }),
    () => post(path3, statusBody(), { signature: "invalid" }),
    () => post(path3, statusBody(), { signUrl: ORIGIN + "/api/twilio/status?callLogId=1" }),
    () => post(path3, statusBody(), { signUrl: ORIGIN + "/api/twilio/voice?callLogId=3" }),
    () => post(path3, statusBody(CALL_C, "completed", "9999"), { signBody: statusBody() }),
    () => post(path3, { ...statusBody(), Extra: "1" }, { signBody: statusBody() }),
    () => post(path3 + "&history=forged", statusBody(), { signUrl: ORIGIN + path3 }),
    () => post(path3, statusBody(), { token: TOKEN_B }),
    () => post(path3, statusBody(CALL_C, "completed", "42", ACCOUNT_B)),
  ]) {
    const res = await attempt();
    assert.equal(res.status, 403);
    assert.equal(res.text, "Forbidden");
  }
  assert.equal(writes, 0);
  assert.equal(ended(3), 0);
  assert.ok(rejections().every((reason) => reason === "signature"));

  const ok = await post(path3, statusBody());
  assert.equal(ok.status, 200);
  const call = rows.call_logs[2];
  assert.equal(call.outcome, "answered");
  assert.equal(call.duration, 42);
  assert.ok(call.finalizedAt instanceof Date);
  assert.ok(call.endedAt instanceof Date);
  assert.equal(ended(3), 1);
  assert.ok(logs.some((l) => l.event === "twilio_status_callback" && l.callLogId === 3 && l.providerStatus === "completed"));
});

test("the Host header cannot change the validation URL; missing or unsafe PUBLIC_BASE_URL fails closed", async (t) => {
  const post = await harness(t);
  const path3 = "/api/twilio/status?callLogId=3";
  const previous = process.env.PUBLIC_BASE_URL;
  try {
    for (const value of [undefined, "http://dialog.test", "https://dialog.test/base", "https://user@dialog.test", "not a url"]) {
      if (value === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = value;
      const candidates = value?.startsWith("http") ? [ORIGIN + path3, value + path3] : [ORIGIN + path3];
      for (const signUrl of candidates)
        assert.equal((await post(path3, statusBody(), { signUrl })).status, 403);
    }
  } finally {
    process.env.PUBLIC_BASE_URL = previous;
  }
  assert.ok(rejections().every((reason) => reason === "canonical_url_config"));

  const attacker = { host: "attacker.test", "x-forwarded-host": "attacker.test", "x-forwarded-proto": "http" };
  for (const signUrl of [`https://attacker.test${path3}`, `http://attacker.test${path3}`, `http://dialog.test${path3}`])
    assert.equal((await post(path3, statusBody(), { signUrl, headers: attacker })).status, 403);
  assert.equal(writes, 0);

  const ok = await post(path3, statusBody(), { headers: attacker });
  assert.equal(ok.status, 200);
  assert.equal(ended(3), 1);
});

test("cross-tenant, mismatched-account and mismatched-call callbacks cannot mutate a call", async (t) => {
  const post = await harness(t);
  // Tenant B fully controls its own Twilio credentials, yet cannot touch tenant A's call.
  assert.equal((await post("/api/twilio/status?callLogId=1", statusBody(CALL_A, "completed", "5", ACCOUNT_B), { token: TOKEN_B })).status, 403);
  assert.equal((await post("/api/twilio/status?callLogId=2", statusBody(CALL_B))).status, 403);
  assert.equal((await post("/api/twilio/status?callLogId=1", statusBody(CALL_C))).status, 403);
  assert.equal((await post("/api/twilio/status", statusBody(CALL_B))).status, 403);
  assert.equal((await post("/api/twilio/status?callLogId=999", statusBody())).status, 403);
  assert.equal((await post("/api/twilio/status?callLogId=3abc", statusBody())).status, 403);
  for (const mutate of [
    () => (rows.tenants[0].status = "suspended"),
    () => (rows.tenants[0].telephonyType = "EXOTEL"),
    () => rows.tenants.push({ id: 3, ownerId: 10, status: "active", telephonyType: "TWILIO" }),
    () => (rows.agent_configs[0].twilioAuthToken = null),
    () => rows.agent_configs.push({ ...rows.agent_configs[0] }),
  ]) {
    const snapshot = structuredClone({ tenants: rows.tenants, agents: rows.agent_configs });
    mutate();
    assert.equal((await post("/api/twilio/status?callLogId=3", statusBody())).status, 403);
    rows.tenants = snapshot.tenants;
    rows.agent_configs = snapshot.agents;
  }
  assert.equal(writes, 0);
  assert.equal(events.length, 0);

  // CallSid-only lookup resolves credentials from the matched call's own tenant.
  assert.equal((await post("/api/twilio/status", statusBody(CALL_B, "completed", "7", ACCOUNT_B), { token: TOKEN_B })).status, 200);
  assert.equal(rows.call_logs[1].duration, 7);

  // An unbound outbound call is bound only by a verified callback, and only once.
  assert.equal((await post("/api/twilio/status?callLogId=4", statusBody(CALL_D, "busy", "0"))).status, 200);
  assert.equal(rows.call_logs[3].callSid, CALL_D);
  assert.equal(rows.call_logs[3].outcome, "busy");
  assert.equal((await post("/api/twilio/status?callLogId=4", statusBody(sid("CA", "e"), "completed", "50"))).status, 403);
  assert.equal(rows.call_logs[3].callSid, CALL_D);
  assert.equal(rows.call_logs[3].outcome, "busy");
});

test("speech-loop routes require a call-bound signature and emit only canonical callback URLs", async (t) => {
  const post = await harness(t);
  const voice = "/api/twilio/voice?callLogId=3&silent=1";
  const body = { AccountSid: ACCOUNT_A, CallSid: CALL_C };
  const attacker = { host: "attacker.test", "x-forwarded-proto": "http" };
  assert.equal((await post(voice, body, { signature: null })).status, 403);
  assert.equal((await post(voice, { ...body, CallSid: CALL_A })).status, 403);
  assert.equal((await post("/api/twilio/voice?callLogId=2&silent=1", { AccountSid: ACCOUNT_B, CallSid: CALL_B })).status, 403);
  assert.equal((await post("/api/twilio/voice-indic?callLogId=3", body, { signature: null })).status, 403);

  const ok = await post(voice, body, { headers: attacker });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /https:\/\/dialog\.test\/api\/twilio\/voice\?callLogId=3/);
  assert.doesNotMatch(ok.text, /attacker/);
  const indic = await post("/api/twilio/voice-indic?callLogId=3", body, { headers: attacker });
  assert.equal(indic.status, 200);
  assert.match(indic.text, /https:\/\/dialog\.test\/api\/twilio\/voice\?callLogId=3/);
  assert.doesNotMatch(indic.text, /attacker/);

  rows.call_logs[2].endedAt = new Date();
  assert.equal((await post(voice, body)).status, 403);
  assert.equal(aiCalls.length, 0);

  const hold = await post("/api/twilio/hold-music?lang=en-US", {}, { signature: null, headers: attacker });
  assert.equal(hold.status, 200);
  assert.match(hold.text, /https:\/\/dialog\.test\/api\/twilio\/hold-music/);
  assert.doesNotMatch(hold.text, /attacker/);
});

test("duplicate, concurrent and out-of-order status callbacks finalize once and advance the campaign once", async (t) => {
  const post = await harness(t);
  const path1 = "/api/twilio/status?callLogId=1";
  for (const status of ["ringing", "in-progress", "queued"])
    assert.equal((await post(path1, statusBody(CALL_A, status, "0"))).status, 200);
  assert.equal(rows.call_logs[0].finalizedAt, undefined);
  assert.equal(rows.campaign_contacts[0].status, "calling");

  const results = await Promise.all([
    post(path1, statusBody(CALL_A, "no-answer", "0")),
    post(path1, statusBody(CALL_A, "no-answer", "0")),
    post(path1, statusBody(CALL_A, "no-answer", "0")),
  ]);
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
  assert.equal(ended(1), 1);
  assert.equal(rows.campaign_contacts[0].status, "retrying");
  const nextAttempt = rows.campaign_contacts[0].nextAttemptAt.getTime();

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal((await post(path1, statusBody(CALL_A, "completed", "30"))).status, 200);
  assert.equal((await post(path1, statusBody(CALL_A, "no-answer", "0"))).status, 200);
  assert.equal(rows.call_logs[0].outcome, "no_answer");
  assert.equal(rows.call_logs[0].duration, 0);
  assert.equal(rows.campaign_contacts[0].nextAttemptAt.getTime(), nextAttempt);
  assert.equal(ended(1), 1);

  // A call already ended by hangup/stream close keeps its end time; billing still finalizes once.
  // Same-tick finalizers (e.g. stream close racing the status callback) both pass
  // the read-side check; only the conditional claim keeps the side effects single.
  rows.campaign_contacts[0] = { id: 1, campaignId: 5, contactId: 7, attempts: 1, status: "calling", nextAttemptAt: null, callLogId: 1 };
  rows.call_logs[0].finalizedAt = null;
  events.length = 0;
  await Promise.all([
    completeCallLog(1, "no-answer", 0, ORIGIN),
    completeCallLog(1, "busy", 0, ORIGIN),
    completeCallLog(1, "completed", 9, ORIGIN),
  ]);
  assert.equal(ended(1), 1);

  const hungUp = new Date(Date.now() - 60_000);
  rows.call_logs[2].endedAt = hungUp;
  assert.equal((await post("/api/twilio/status?callLogId=3", statusBody(CALL_C, "completed", "12"))).status, 200);
  assert.equal((await post("/api/twilio/status?callLogId=3", statusBody(CALL_C, "completed", "99"))).status, 200);
  assert.equal(rows.call_logs[2].endedAt.getTime(), hungUp.getTime());
  assert.equal(rows.call_logs[2].duration, 12);
  assert.equal(ended(3), 1);
});

test("conference and agent-leg callbacks release the reserved agent slot once, only for the bound transfer", async (t) => {
  const post = await harness(t);
  const agent = () => rows.crm_agents[0].currentCalls;
  const pathOf = (url: string) => url.slice(ORIGIN.length);
  const conference = (name: string, event: string, extra = {}) => ({
    AccountSid: ACCOUNT_A, ConferenceSid: sid("CF", "a"), FriendlyName: name, StatusCallbackEvent: event, CallSid: CALL_A, ...extra,
  });
  const agentLeg = (status: string) => ({ AccountSid: ACCOUNT_A, CallSid: sid("CA", "f"), CallStatus: status });
  // The agent already holds a slot for another customer's call, so any extra
  // decrement is visible instead of being hidden by the zero floor.
  rows.crm_agents[0].currentCalls = 1;
  const HELD = 1;

  await reserveTransferSlot(1, 10, "crm-transfer-1-100", "agent-a");
  assert.equal(agent(), HELD + 1);
  assert.equal(rows.call_logs[0].transferAgentId, 1);
  const first = transferCallbackUrls(1, "crm-transfer-1-100", "en-US");
  assert.ok(first.conferenceStatus.startsWith(ORIGIN + "/api/twilio/conference-status?callId=1&transfer="));
  assert.ok(first.agentCallStatus.startsWith(ORIGIN + "/api/twilio/agent-call-status?callId=1&transfer="));
  assert.ok(first.holdMusic.startsWith(ORIGIN + "/api/twilio/hold-music?"));

  const confPath = pathOf(first.conferenceStatus);
  const agentPath = pathOf(first.agentCallStatus);
  assert.equal((await post(confPath, conference("crm-transfer-1-100", "participant-leave"), { signature: null })).status, 403);
  assert.equal((await post(agentPath, agentLeg("completed"), { signature: "forged" })).status, 403);
  assert.equal((await post(confPath, conference("crm-transfer-1-100", "conference-end", { AccountSid: ACCOUNT_B }), { token: TOKEN_B })).status, 403);
  assert.equal((await post(confPath.replace("callId=1", "callId=2"), conference("crm-transfer-1-100", "conference-end"))).status, 403);
  assert.equal(agent(), HELD + 1);

  assert.equal((await post(confPath, conference("crm-transfer-1-100", "participant-join"))).status, 200);
  const stale = pathOf(transferCallbackUrls(1, "crm-transfer-1-099", "en-US").conferenceStatus);
  assert.equal((await post(stale, conference("crm-transfer-1-099", "conference-end"))).status, 200);
  assert.equal((await post(confPath, conference("crm-transfer-1-099", "conference-end"))).status, 200);
  assert.equal(agent(), HELD + 1);

  assert.equal((await post(confPath, conference("crm-transfer-1-100", "participant-leave"))).status, 200);
  assert.equal(agent(), HELD);
  assert.ok(rows.call_logs[0].transferReleasedAt instanceof Date);
  const duplicates = await Promise.all([
    post(confPath, conference("crm-transfer-1-100", "participant-leave")),
    post(confPath, conference("crm-transfer-1-100", "conference-end")),
    post(agentPath, agentLeg("completed")),
    post(confPath, conference("crm-transfer-1-100", "participant-join")),
  ]);
  assert.deepEqual(duplicates.map((r) => r.status), [200, 200, 200, 200]);
  assert.equal(await releaseTransferSlot(1, "crm-transfer-1-100"), false);
  assert.equal(agent(), HELD);

  // A later transfer on the same call is unaffected by late events from the first,
  // including one whose verification read raced the new reservation.
  await reserveTransferSlot(1, 10, "crm-transfer-1-200", "agent-a");
  assert.equal(agent(), HELD + 1);
  assert.equal((await post(confPath, conference("crm-transfer-1-100", "conference-end"))).status, 200);
  assert.equal((await post(agentPath, agentLeg("completed"))).status, 200);
  assert.equal(await releaseTransferSlot(1, "crm-transfer-1-100"), false);
  assert.equal(agent(), HELD + 1);
  const second = transferCallbackUrls(1, "crm-transfer-1-200", "en-US");
  assert.equal((await post(pathOf(second.agentCallStatus), agentLeg("ringing"))).status, 200);
  assert.equal(agent(), HELD + 1);
  assert.equal((await post(pathOf(second.agentCallStatus), agentLeg("busy"))).status, 200);
  assert.equal(agent(), HELD);

  // Re-transferring before release frees the previous reservation instead of leaking it.
  await reserveTransferSlot(1, 10, "crm-transfer-1-300", "agent-a");
  await reserveTransferSlot(1, 10, "crm-transfer-1-400", "agent-a");
  assert.equal(agent(), HELD + 1);

  // Speech-loop transfers never reserved a slot, so their callbacks never decrement.
  await reserveTransferSlot(3, 10, "auto-transfer-3-1");
  const auto = pathOf(transferCallbackUrls(3, "auto-transfer-3-1", "en-US").conferenceStatus);
  assert.equal((await post(auto, conference("auto-transfer-3-1", "conference-end", { CallSid: CALL_C }))).status, 200);
  assert.equal(agent(), HELD + 1);
  assert.equal(rows.call_logs[2].transferAgentId, null);
});

test("concurrent transfers on different calls never lose agent counter updates", async () => {
  rows.crm_agents[0].currentCalls = 0;
  await Promise.all([
    reserveTransferSlot(1, 10, "crm-transfer-1-700", "agent-a"),
    reserveTransferSlot(3, 10, "crm-transfer-3-700", "agent-a"),
  ]);
  assert.equal(rows.crm_agents[0].currentCalls, 2);
  const released = await Promise.all([
    releaseTransferSlot(1, "crm-transfer-1-700"),
    releaseTransferSlot(3, "crm-transfer-3-700"),
    releaseTransferSlot(1, "crm-transfer-1-700"),
  ]);
  assert.deepEqual(released, [true, true, false]);
  assert.equal(rows.crm_agents[0].currentCalls, 0);
  // Another tenant's agent with the same CRM identifier is never touched.
  rows.crm_agents.push({ id: 2, userId: 20, crmAgentId: "agent-a", name: "Other tenant", phone: "+15550002222", isAvailable: true, maxConcurrentCalls: 3, currentCalls: 2 });
  await reserveTransferSlot(1, 10, "crm-transfer-1-701", "agent-a");
  await releaseTransferSlot(1, "crm-transfer-1-701");
  assert.equal(rows.crm_agents[1].currentCalls, 2);
});

test("a failed provider transfer releases its reservation; retired CRM-key callback paths no longer mutate", async (t) => {
  const post = await harness(t);
  const result = await executeTransfer(10, {
    callId: 1, callSid: CALL_A, transferTo: AGENT_PHONE, reason: "pricing_query", transferType: "cold", crmAgentId: "agent-a",
  });
  assert.equal(result.success, false);
  assert.equal(rows.crm_agents[0].currentCalls, 0);
  assert.ok(rows.call_logs[0].transferReleasedAt instanceof Date);
  assert.equal(rows.call_logs[0].transferredTo, undefined);

  await reserveTransferSlot(1, 10, "crm-transfer-1-500", "agent-a");
  const body = { AccountSid: ACCOUNT_A, StatusCallbackEvent: "participant-leave", FriendlyName: "crm-transfer-1-500" };
  for (const route of ["/api/crm/conference-status?callId=1", "/api/crm/agent-call-status?callId=1"]) {
    assert.equal((await post(route, body, { signature: null })).status, 401);
    const withKey = await post(route, body, { signature: null, headers: { authorization: `Bearer ${CRM_KEY_B}` } });
    assert.notEqual(withKey.status, 200);
  }
  assert.equal(rows.crm_agents[0].currentCalls, 1);
  assert.equal(rows.call_logs[0].transferReleasedAt, null);
});

test("dashboard and CRM authentication contracts are unchanged; provider signatures authenticate nothing else", async (t) => {
  const post = await harness(t);
  assert.equal((await post("/api/crm/calls", { phone: CALLER })).status, 401);
  assert.equal((await post("/api/dial/calls/1/end", {})).status, 401);
  assert.equal((await post("/api/dial/calls/1/end", {}, { signature: null, headers: { authorization: "Bearer not-a-jwt" } })).status, 401);
  const crmToTwilio = await post("/api/twilio/status?callLogId=2", statusBody(CALL_B, "completed", "5", ACCOUNT_B), {
    signature: null, headers: { authorization: `Bearer ${CRM_KEY_B}` },
  });
  assert.equal(crmToTwilio.status, 403);
  assert.equal(rows.call_logs[1].finalizedAt, undefined);
});

test("Twilio webhook logs carry only safe metadata on success and failure", async (t) => {
  const post = await harness(t);
  signatures.length = 0;
  await post("/api/twilio/status?callLogId=3", statusBody(), { signature: "forged-signature-value" });
  await post("/api/twilio/status?callLogId=1", statusBody(CALL_A, "completed", "5", ACCOUNT_B), { token: TOKEN_B });
  await post("/api/twilio/status?callLogId=3", statusBody());
  await reserveTransferSlot(1, 10, "crm-transfer-1-600", "agent-a");
  const urls = transferCallbackUrls(1, "crm-transfer-1-600", "en-US");
  await post(urls.conferenceStatus.slice(ORIGIN.length), {
    AccountSid: ACCOUNT_A, FriendlyName: "crm-transfer-1-600", StatusCallbackEvent: "conference-end", ConferenceSid: sid("CF", "a"),
  });
  await executeTransfer(10, { callId: 1, callSid: CALL_A, transferTo: AGENT_PHONE, reason: "pricing_query", transferType: "cold", crmAgentId: "agent-a" });

  const output = emitted();
  for (const secret of [TOKEN_A, TOKEN_B, "forged-signature-value", ...signatures, CALLER, AGENT_PHONE, ACCOUNT_A, ACCOUNT_B, CALL_A, CALL_C, "callLogId=", "transfer=", "crm-transfer-1-600", "dialog.test/api"])
    assert.ok(!output.includes(secret), "log output must not contain sensitive webhook data");
  assert.ok(logs.some((l) => l.event === "twilio_webhook_rejected" && l.route === "status" && l.reason === "signature" && typeof l.latencyMs === "number"));
  assert.ok(logs.some((l) => l.event === "twilio_status_callback" && l.callLogId === 3));
  assert.ok(logs.some((l) => l.event === "twilio_conference_status" && l.callLogId === 1 && l.released === true));
});

import "./postgres-twilio-webhooks.test";

test("migration 0005 only adds nullable call_logs columns and leaves 0004 unchanged", async () => {
  const directory = path.resolve("../../lib/db/drizzle");
  const previous = JSON.parse(await readFile(path.join(directory, "meta/0004_snapshot.json"), "utf8"));
  const next = JSON.parse(await readFile(path.join(directory, "meta/0005_snapshot.json"), "utf8"));
  assert.equal(next.prevId, previous.id);
  const tables = structuredClone(next.tables);
  for (const column of ["transfer_agent_id", "transfer_released_at", "finalized_at"]) {
    assert.equal(tables["public.call_logs"].columns[column].notNull, false);
    assert.equal(tables["public.call_logs"].columns[column].default, undefined);
    delete tables["public.call_logs"].columns[column];
  }
  assert.deepEqual(tables, previous.tables);
  const sql = await readFile(path.join(directory, "0005_twilio_webhook_idempotency.sql"), "utf8");
  const statements = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 3);
  for (const statement of statements)
    assert.match(statement, /^ALTER TABLE "call_logs" ADD COLUMN "(transfer_agent_id" integer|transfer_released_at" timestamp|finalized_at" timestamp);$/);
  const journal = JSON.parse(await readFile(path.join(directory, "meta/_journal.json"), "utf8"));
  assert.deepEqual(journal.entries.slice(4, 6).map((e: any) => e.tag), [
    "0004_widget_verification_policies",
    "0005_twilio_webhook_idempotency",
  ]);
});
