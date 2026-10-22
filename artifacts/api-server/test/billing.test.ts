// Phase 1L: usage ledger, spend limits and ledger-backed invoices. Synthetic
// tenants, rates and provider responses only; no provider is ever contacted.
// The fake database runs transactions without isolation, so concurrency
// guarantees are asserted only by postgres-billing.test.ts.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import express from "express";
import { rows, resetDatabase, db } from "./fake-db";
import { emitted, resetLogs } from "./capture-logger";
import { aiBehavior, chatRequests } from "./fake-ai";
import { resetRateLimitingForTests } from "../src/lib/rate-limit";
import { resolveUser, requireSuperadmin, signToken } from "../src/middleware/auth";
import { safeErrorHandler } from "../src/lib/error-handler";
import widgetRouter from "../src/routes/widget";
import invoicesRouter, { checkAndMarkOverdueInvoices } from "../src/routes/invoices";
import adminCostsRouter from "../src/routes/admin-costs";
import {
  afterProviderSuccess,
  classifyProviderFailure,
  createUsageScope,
  recordUsage,
  resolveUsageEntry,
  syncCallLogCosts,
} from "../src/lib/billing/usage-ledger";
import { providerHttpError } from "../src/lib/log-redaction";
import { completeCallLog } from "../src/routes/twilio";
import { recordLlmCall, reportedUsage } from "../src/lib/billing/llm-usage";
import { invalidateRateCard, currentRateCard } from "../src/lib/billing/rate-card";
import {
  billingPeriod,
  getBudgetState,
  releaseReservation,
  reserveBudget,
  SpendLimitError,
} from "../src/lib/billing/spend-budget";
import {
  extendCallHold,
  recordCallTelephony,
  reserveCallBudget,
  reserveTurnBudget,
  settleCall,
} from "../src/lib/billing/call-usage";
import { generateLedgerInvoice, InvoiceError } from "../src/lib/billing/invoicing";
import { createRequestMeter } from "../src/lib/billing/request-meter";

const PHONE = "+15550100777";
const TRANSCRIPT = "Synthetic caller discusses a private billing matter";
const widgetKey = "wk_fake_" + "e".repeat(40);
const bearer = (tenantUserId: number, jti: string) => "Bearer " + signToken({ tenantUserId, jti } as any);
const ADMIN_A = bearer(100, "a".repeat(64));
const ADMIN_B = bearer(200, "b".repeat(64));
const SUPER = bearer(900, "d".repeat(64));
const PERIOD = billingPeriod();
const close = (actual: unknown, expected: number) =>
  assert.ok(Math.abs(Number(actual) - expected) < 1e-9, `${actual} != ${expected}`);
const ledger = () => rows.usage_ledger ?? [];
const committed = async (tenantId: number) => (await getBudgetState(tenantId)).committedUsd;
const reserved = async (tenantId: number) => (await getBudgetState(tenantId)).reservedUsd;
const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay();
  }
  assert.fail("Timed out waiting for test effect");
}

let server: Server;
let base = "";
before(async () => {
  // Mirrors app.ts mount order for the routers under test.
  const app = express();
  app.use(express.json());
  app.use(widgetRouter);
  app.use("/api", resolveUser);
  app.use("/api", invoicesRouter);
  app.use("/api", requireSuperadmin, adminCostsRouter);
  app.use(safeErrorHandler());
  server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
  for (const timer of (globalThis as any).__dialogTestIntervals) clearInterval(timer);
});

beforeEach(() => {
  resetDatabase();
  resetLogs();
  resetRateLimitingForTests();
  invalidateRateCard();
  aiBehavior.chatReply = null;
  chatRequests.length = 0;
  rows.users = [{ id: 10 }, { id: 20 }, { id: 99, isSuperadmin: true }];
  rows.tenants = [
    { id: 1, ownerId: 10, name: "Tenant A", slug: "a", status: "active", commissionPct: "20", paymentTermsDays: 30, telephonyType: "TWILIO", createdAt: new Date() },
    { id: 2, ownerId: 20, name: "Tenant B", slug: "b", status: "active", commissionPct: "0", paymentTermsDays: 30, telephonyType: "TWILIO", createdAt: new Date() },
    { id: 9, ownerId: 99, name: "Platform", slug: "p", status: "active", commissionPct: "0", createdAt: new Date() },
  ];
  const member = (id: number, tenantId: number, userId: number | null) =>
    ({ id, tenantId, userId, role: "admin", email: `member-${id}@example.test`, isActive: true, name: "Fake member" });
  rows.tenant_users = [member(100, 1, null), member(200, 2, null), member(900, 9, 99)];
  rows.tenant_sessions = ([[1, "a", 100, 1], [2, "b", 200, 2], [3, "d", 900, 9]] as const).map(([id, ch, tenantUserId, tenantId]) => ({
    id, token: ch.repeat(64), tenantUserId, tenantId, expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null,
  }));
  rows.agent_configs = [{
    id: 1, userId: 10, agentName: "Fake agent", greeting: "Hello", personality: "friendly", language: "en-US",
    widgetApiKey: widgetKey, widgetEnabled: true, widgetExternalCrmEnabled: false, widgetVoiceEnabled: true, maxCallDuration: 10,
  }];
  rows.call_logs = [
    { id: 1, userId: 10, direction: "outbound", phoneNumber: PHONE, transcript: TRANSCRIPT, startedAt: new Date(), callSid: "CA" + "1".repeat(32) },
    { id: 2, userId: 20, direction: "outbound", phoneNumber: PHONE, startedAt: new Date(), callSid: "CA" + "2".repeat(32) },
  ];
});

async function api(method: string, path: string, auth: string | null, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

function exhaust(tenantId: number, limit = 1) {
  rows.tenant_limits = [{ id: tenantId, tenantId, monthlyLimitUsd: limit.toFixed(2), hardLimit: true }];
  rows.tenant_budget_periods = [{ id: 1, tenantId, period: PERIOD, currency: "USD", committedAmount: limit.toFixed(8), reservedAmount: "0" }];
}

const llm = (key: string, extra: Record<string, unknown> = {}) => ({
  userId: 10, source: "test", category: "llm" as const, provider: "openai", model: "gpt-4o-mini",
  idempotencyKey: key, measurement: "actual" as const, unit: "tokens" as const,
  quantity: 1500, inputTokens: 1000, outputTokens: 500, ...extra,
});

// ── Recording and pricing ────────────────────────────────────────────────

test("each category records normalized units, the rate version, USD, and cost separate from the billable amount", async () => {
  const card = await currentRateCard();
  await recordUsage(llm("llm-1"));
  await recordUsage({ userId: 10, source: "test", category: "tts", provider: "sarvam", model: "bulbul:v3", idempotencyKey: "tts-1", measurement: "estimated", unit: "characters", quantity: 1000 });
  await recordUsage({ userId: 10, source: "test", category: "stt", provider: "openai", model: "whisper-1", idempotencyKey: "stt-1", measurement: "estimated", unit: "audio_seconds", quantity: 90 });
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: 61, measurement: "actual", reason: "provider_callback" });

  const [l, t, s, tel] = ledger();
  close(l.platformCost, (1000 * 0.15 + 500 * 0.6) / 1e6);
  close(l.billableAmount, ((1000 * 0.15 + 500 * 0.6) / 1e6) * 1.2);
  close(t.platformCost, (1000 * 3) / 1e6);
  close(s.platformCost, 1.5 * 0.006);
  // Started-minute rounding: 61 s bills as 2 minutes.
  close(tel.billedUnits, 2);
  close(tel.platformCost, 2 * 0.013);
  for (const entry of ledger()) {
    assert.equal(entry.currency, "USD");
    assert.equal(entry.rateVersion, card.version);
    assert.equal(entry.status, "finalized");
    assert.equal(entry.tenantId, 1);
  }
  close(await committed(1), ledger().reduce((sum: number, e: any) => sum + Number(e.platformCost), 0));
});

test("cached input tokens use a configured cached rate; a rate change creates a new immutable version", async () => {
  await recordUsage(llm("cached-1", { inputTokens: 1000, cachedInputTokens: 600 }));
  const first = ledger()[0];
  // No cached rate configured: cached tokens are priced at the full input rate, never at zero.
  close(first.platformCost, (1000 * 0.15 + 500 * 0.6) / 1e6);

  rows.platform_settings = [{ key: "rate:llm:gpt-4o-mini:cached_input", value: "0.075" }];
  invalidateRateCard();
  await recordUsage(llm("cached-2", { inputTokens: 1000, cachedInputTokens: 600 }));
  const second = ledger()[1];
  close(second.platformCost, (400 * 0.15 + 600 * 0.075 + 500 * 0.6) / 1e6);
  assert.notEqual(second.rateVersion, first.rateVersion);
  assert.equal(rows.billing_rate_cards.length, 2);
  // The earlier entry keeps the version it was priced with.
  assert.equal(ledger()[0].rateVersion, first.rateVersion);
  assert.deepEqual(reportedUsage({ prompt_tokens: 9, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } }), { inputTokens: 9, outputTokens: 3, cachedInputTokens: 4 });
});

test("missing rates and unsupported providers are never recorded as zero cost", async () => {
  await recordUsage({ userId: 10, source: "test", category: "stt", provider: "sarvam", model: "saaras:v3", idempotencyKey: "stt-sarvam", measurement: "estimated", unit: "audio_seconds", quantity: 30 });
  await recordUsage({ userId: 10, source: "test", category: "tts", provider: "fake-voice", model: "x", idempotencyKey: "tts-unknown", measurement: "actual", unit: "characters", quantity: 100 });
  await recordUsage(llm("llm-unknown", { model: "fake-model-without-rate" }));
  await recordCallTelephony(rows.call_logs[0], { provider: "exotel", seconds: 120, measurement: "estimated", reason: "unverified_callback", provisionalAmount: 0.05 });

  for (const entry of ledger()) {
    assert.equal(entry.status, "needs_reconciliation");
    assert.equal(entry.platformCost, null);
    assert.equal(entry.billableAmount, null);
    assert.match(entry.statusReason, /^missing_rate:/);
  }
  // A provisional amount still counts against the limit while the cost is unknown.
  close(await committed(1), 0.05);
  const costs = await syncCallLogCosts(1);
  assert.equal(costs.totalCost, null);
  assert.equal(rows.call_logs[0].estimatedCostUsd, null);
  assert.equal(rows.call_logs[0].twilioCostUsd, null);

  // Once a super admin sets the rate, repricing replaces the provisional amount (no double count).
  rows.platform_settings = [{ key: "rate:telephony:exotel:outbound", value: "0.01" }];
  invalidateRateCard();
  const telephony = ledger().find((e: any) => e.category === "telephony");
  assert.equal(await resolveUsageEntry(2, telephony.id, { kind: "reprice" }), null, "another tenant cannot resolve it");
  assert.deepEqual(await resolveUsageEntry(1, telephony.id, { kind: "reprice" }), { status: "finalized" });
  close(telephony.platformCost, 0.02);
  close(await committed(1), 0.02);
});

// ── Idempotency and reconciliation ───────────────────────────────────────

test("repeated callbacks and retries record usage once", async () => {
  for (let i = 0; i < 3; i++) await recordUsage(llm("same-key"));
  for (let i = 0; i < 3; i++) await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: 61, measurement: "actual" });
  assert.equal(ledger().length, 2);
  close(await committed(1), (1000 * 0.15 + 500 * 0.6) / 1e6 + 0.026);
  // Same key, different tenant: separate usage identities.
  await recordUsage({ ...llm("same-key"), userId: 20 });
  assert.equal(ledger().length, 3);
  close(await committed(2), (1000 * 0.15 + 500 * 0.6) / 1e6);
});

test("actual usage reconciles an estimate in place without double counting, and weaker evidence never overwrites it", async () => {
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: 125, measurement: "estimated", reason: "media_close" });
  close(await committed(1), 3 * 0.013);
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: 61, measurement: "actual", reason: "provider_callback" });
  assert.equal(ledger().length, 1);
  const entry = ledger()[0];
  assert.equal(entry.measurement, "actual");
  assert.equal(entry.revision, 1);
  close(entry.platformCost, 0.026);
  close(await committed(1), 0.026);
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: 300, measurement: "estimated", reason: "media_close" });
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: null, measurement: "unknown", provisionalAmount: 1 });
  close(ledger()[0].platformCost, 0.026);
  close(await committed(1), 0.026);

  // LLM: a token estimate (no usage reported) is replaced by reported usage.
  const scope = createUsageScope({ userId: 10, source: "test", keyPrefix: "turn-1" });
  await recordLlmCall(scope, { provider: "openai", model: "gpt-4o-mini", usage: null, promptTexts: ["x".repeat(4000)], outputText: "y".repeat(400), key: "llm" });
  await recordLlmCall(scope, { provider: "openai", model: "gpt-4o-mini", usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 }, promptTexts: [], key: "llm" });
  const llmEntry = ledger().find((e: any) => e.category === "llm");
  assert.equal(llmEntry.measurement, "actual");
  assert.equal(llmEntry.inputTokens, 1000);
  close(await committed(1), 0.026 + (1000 * 0.15 + 100 * 0.6) / 1e6);
});

test("an ambiguous dispatch keeps a provisional hold until a late callback supplies the duration", async () => {
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: null, measurement: "unknown", provisionalAmount: 0.13, reason: "dispatch_unknown" });
  const entry = ledger()[0];
  assert.equal(entry.status, "needs_reconciliation");
  assert.equal(entry.statusReason, "quantity_unknown");
  close(await committed(1), 0.13);
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: 61, measurement: "actual", reason: "provider_callback" });
  assert.equal(ledger().length, 1);
  assert.equal(entry.status, "finalized");
  close(await committed(1), 0.026);
  // Operator evidence that the provider never charged.
  await recordCallTelephony(rows.call_logs[1], { provider: "twilio", seconds: null, measurement: "unknown", provisionalAmount: 0.13 });
  const other = ledger()[1];
  assert.deepEqual(await resolveUsageEntry(2, other.id, { kind: "not_charged" }), { status: "failed" });
  close(await committed(2), 0);
});

test("provider failures: HTTP rejections are not charged, timeouts stay for reconciliation, abandoned streams assume full output", async () => {
  const scope = createUsageScope({ userId: 10, source: "test", keyPrefix: "f" });
  await recordLlmCall(scope, { provider: "openai", model: "gpt-4o-mini", usage: null, promptTexts: ["hi"], failure: Object.assign(new Error("bad request"), { status: 400 }), maxOutputTokens: 200, key: "rejected" });
  await recordLlmCall(scope, { provider: "openai", model: "gpt-4o-mini", usage: null, promptTexts: ["hi"], failure: new Error("socket hang up"), maxOutputTokens: 200, key: "timeout" });
  await recordLlmCall(scope, { provider: "openai", model: "gpt-4o-mini", usage: null, promptTexts: ["hi"], outputText: "partial", cancelled: true, maxOutputTokens: 200, key: "cancelled" });
  const [rejected, timeout, cancelled] = ledger();
  assert.equal(rejected.status, "failed");
  close(rejected.budgetAmount, 0);
  assert.equal(timeout.status, "needs_reconciliation");
  assert.equal(timeout.statusReason, "provider_outcome_unknown");
  assert.equal(timeout.outputTokens, 200);
  assert.equal(cancelled.status, "finalized");
  assert.equal(cancelled.outputTokens, 200);
  assert.equal(cancelled.metadata.cancelled, true);
  // A TTS fallback race: both providers did work, each recorded once under its own key.
  scope.record({ key: "tts:sarvam", category: "tts", provider: "sarvam", model: "bulbul:v3", measurement: "estimated", unit: "characters", quantity: 100 });
  scope.record({ key: "tts:openai", category: "tts", provider: "openai", model: "tts-1", measurement: "estimated", unit: "characters", quantity: 100, metadata: { discarded: true } });
  scope.record({ key: "tts:openai", category: "tts", provider: "openai", model: "tts-1", measurement: "estimated", unit: "characters", quantity: 100, metadata: { discarded: true } });
  await scope.flush();
  assert.equal(ledger().filter((e: any) => e.category === "tts").length, 2);
});

// ── Ambiguous provider outcomes (Phase 1L-F) ─────────────────────────────

const httpError = (status: number) => providerHttpError("Fake provider", status, "{}");
const llmFailure = (key: string, failure: unknown, extra: Record<string, unknown> = {}) => ({
  provider: "openai", model: "gpt-4o-mini", usage: null, promptTexts: ["x".repeat(2000)], maxOutputTokens: 200, failure, key, ...extra,
});
/** 1000 estimated input tokens plus the full 200-token output allowance. */
const FAILED_LLM_ESTIMATE = (1000 * 0.15 + 200 * 0.6) / 1e6;

test("only confirmed pre-processing rejections are recorded as not charged", async () => {
  const scope = createUsageScope({ userId: 10, source: "test", keyPrefix: "rej" });
  for (const status of [400, 401, 403, 404, 413, 422, 429]) await recordLlmCall(scope, llmFailure(`s${status}`, httpError(status)));
  assert.equal(ledger().length, 7);
  for (const entry of ledger()) {
    assert.deepEqual([entry.status, entry.statusReason], ["failed", "provider_rejected"]);
    close(entry.budgetAmount, 0);
  }
  close(await committed(1), 0);
});

test("HTTP 5xx, 408, 409 and 499 responses are ambiguous: unknown outcome, estimated cost held, never zero", async () => {
  const scope = createUsageScope({ userId: 10, source: "test", keyPrefix: "amb" });
  const statuses = [500, 502, 503, 504, 408, 409, 499];
  for (const status of statuses) await recordLlmCall(scope, llmFailure(`s${status}`, httpError(status)));
  // Media-stream and widget TTS and STT share the classifier.
  await scope.record({ key: "tts", category: "tts", provider: "sarvam", model: "bulbul:v3", measurement: "actual", unit: "characters", quantity: 1000, outcome: classifyProviderFailure(httpError(503)) });
  await scope.record({ key: "stt", category: "stt", provider: "openai", model: "whisper-1", measurement: "actual", unit: "audio_seconds", quantity: 60, outcome: classifyProviderFailure(httpError(500)) });
  assert.equal(ledger().length, statuses.length + 2);
  for (const entry of ledger()) {
    assert.deepEqual([entry.status, entry.statusReason], ["needs_reconciliation", "provider_outcome_unknown"]);
    assert.ok(Number(entry.platformCost) > 0, "an ambiguous failure is never priced at zero");
    close(entry.budgetAmount, entry.platformCost);
    assert.equal(entry.finalizedAt ?? null, null);
  }
  close(await committed(1), statuses.length * FAILED_LLM_ESTIMATE + 1000 * 3 / 1e6 + 0.006);
  // Unknown usage blocks a complete invoice rather than being billed or dropped.
  await assert.rejects(generateLedgerInvoice({ tenantId: 1, period: PERIOD }), (err: any) => err instanceof InvoiceError && err.code === "usage_incomplete");
});

test("timeouts, aborts, network failures and partial streams stay for reconciliation", async () => {
  const scope = createUsageScope({ userId: 10, source: "test", keyPrefix: "net" });
  await recordLlmCall(scope, llmFailure("abort", Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
  await recordLlmCall(scope, llmFailure("network", new TypeError("fetch failed")));
  await recordLlmCall(scope, llmFailure("reset", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })));
  // A 4xx that arrives after the provider already streamed output is not a pre-processing rejection.
  await recordLlmCall(scope, llmFailure("partial", httpError(400), { outputText: "partial reply" }));
  // Sarvam answered 200 but without audio: the outcome is not known.
  await scope.record({ key: "tts-empty", category: "tts", provider: "sarvam", model: "bulbul:v3", measurement: "actual", unit: "characters", quantity: 100, outcome: classifyProviderFailure(new Error("No audio returned from Sarvam")) });
  for (const entry of ledger()) {
    assert.deepEqual([entry.status, entry.statusReason], ["needs_reconciliation", "provider_outcome_unknown"]);
    assert.ok(Number(entry.budgetAmount) > 0);
  }
  assert.equal(ledger().find((e: any) => e.idempotencyKey === "net:partial").outputTokens, 200);
});

test("provider-reported usage is billed despite an error, and a local failure after a successful response is still billed", async () => {
  const scope = createUsageScope({ userId: 10, source: "test", keyPrefix: "rep" });
  await recordLlmCall(scope, llmFailure("reported", httpError(500), { usage: { inputTokens: 900, outputTokens: 50, cachedInputTokens: 0 } }));
  const reported = ledger()[0];
  assert.deepEqual([reported.status, reported.measurement, reported.inputTokens], ["finalized", "actual", 900]);
  close(reported.platformCost, (900 * 0.15 + 50 * 0.6) / 1e6);
  // Audio conversion failed after the TTS provider returned audio.
  assert.equal(classifyProviderFailure(afterProviderSuccess(new Error("conversion failed"))), "charged");
  assert.equal(classifyProviderFailure(afterProviderSuccess("conversion failed")), "charged");
  assert.equal(classifyProviderFailure(httpError(429), { usageReported: true }), "charged");
  assert.equal(classifyProviderFailure(httpError(429), { outputProduced: true }), "unknown");
  assert.equal(classifyProviderFailure(undefined), "unknown");
});

test("late provider evidence reconciles an ambiguous or rejected entry in place without a duplicate", async () => {
  const tts = (key: string, outcome: "charged" | "not_charged" | "unknown") =>
    recordUsage({ userId: 10, source: "test", category: "tts", provider: "sarvam", model: "bulbul:v3", idempotencyKey: key, measurement: "actual", unit: "characters", quantity: 1000, outcome });
  // 5xx, then the provider's usage report confirms the charge.
  await tts("late-1", "unknown");
  close(await committed(1), 0.003);
  const confirmed = await tts("late-1", "charged");
  assert.deepEqual([confirmed.created, confirmed.reconciled, confirmed.status], [false, true, "finalized"]);
  close(await committed(1), 0.003);
  // 5xx, then operator evidence that nothing was billed releases the held amount.
  await tts("late-2", "unknown");
  const second = ledger().find((e: any) => e.idempotencyKey === "late-2");
  assert.deepEqual(await resolveUsageEntry(1, second.id, { kind: "not_charged" }), { status: "failed" });
  close(await committed(1), 0.003);
  // A confirmed rejection that the provider later reports usage for is charged once.
  await tts("late-3", "not_charged");
  close(await committed(1), 0.003);
  await tts("late-3", "unknown");
  assert.equal(ledger().find((e: any) => e.idempotencyKey === "late-3").status, "failed", "an unknown report does not override a rejection");
  await tts("late-3", "charged");
  await tts("late-3", "charged");
  await tts("late-3", "not_charged");
  const third = ledger().find((e: any) => e.idempotencyKey === "late-3");
  assert.deepEqual([third.status, third.revision], ["finalized", 1]);
  close(await committed(1), 0.006);
  assert.equal(ledger().length, 3);
});

test("unanswered calls are free only on a signed Twilio callback; other evidence stays for reconciliation", async () => {
  rows.call_logs.push(
    { id: 3, userId: 10, direction: "outbound", phoneNumber: PHONE, startedAt: new Date(), callSid: "CA" + "3".repeat(32) },
    { id: 4, userId: 20, direction: "outbound", phoneNumber: PHONE, startedAt: new Date(), callSid: "CA" + "4".repeat(32) },
  );
  await completeCallLog(1, "busy", 0, undefined, "provider_callback");
  await completeCallLog(3, "no-answer", 0, undefined, "unverified_callback");
  rows.tenants[1].telephonyType = "EXOTEL";
  await completeCallLog(4, "no-answer", 0, undefined, "provider_callback");
  const entry = (id: number) => ledger().find((e: any) => e.callLogId === id);
  assert.deepEqual([entry(1).status, entry(1).statusReason], ["failed", "provider_rejected"]);
  assert.deepEqual([entry(3).status, entry(3).statusReason], ["needs_reconciliation", "provider_outcome_unknown"]);
  assert.equal(entry(4).status, "needs_reconciliation");
  assert.match(entry(4).statusReason, /^missing_rate:/);
  // A later signed answered callback replaces the unverified one.
  await completeCallLog(3, "completed", 61, undefined, "provider_callback");
  assert.deepEqual([entry(3).status, entry(3).measurement, Number(entry(3).quantity)], ["finalized", "actual", 61]);
  assert.equal(ledger().filter((e: any) => e.callLogId === 3).length, 1);
});

test("call-log cost columns mirror the ledger and stay null while any usage is unpriced", async () => {
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: 61, measurement: "actual" });
  const scope = createUsageScope({ userId: 10, source: "media-stream", keyPrefix: "call:1:media", callLogId: 1 });
  scope.record({ category: "llm", provider: "openai", model: "gpt-4o-mini", measurement: "actual", unit: "tokens", quantity: 1500, inputTokens: 1000, outputTokens: 500 });
  await scope.flush();
  const totals = await syncCallLogCosts(1);
  const llmCost = (1000 * 0.15 + 500 * 0.6) / 1e6;
  close(totals.totalCost!, 0.026 + llmCost);
  close(rows.call_logs[0].estimatedCostUsd, 0.026 + llmCost);
  close(rows.call_logs[0].billedCostUsd, (0.026 + llmCost) * 1.2);
  close(rows.call_logs[0].twilioCostUsd, 0.026);
  close(rows.call_logs[0].openaiCostUsd, llmCost);
  scope.record({ category: "stt", provider: "sarvam", model: "saaras:v3", measurement: "estimated", unit: "audio_seconds", quantity: 5 });
  await scope.flush();
  await syncCallLogCosts(1);
  assert.equal(rows.call_logs[0].estimatedCostUsd, null);
  close(rows.call_logs[0].twilioCostUsd, 0.026);
});

// ── Budget enforcement ───────────────────────────────────────────────────

test("hard limits refuse new paid work before the provider request; soft limits warn", async () => {
  rows.tenant_limits = [{ id: 1, tenantId: 1, monthlyLimitUsd: "0.05", hardLimit: true }];
  const hold = (key: string, amount: number) => reserveBudget({ userId: 10, key, amount, source: "test", ttlMs: 60_000 });
  await hold("a", 0.03);
  await assert.rejects(hold("b", 0.03), (err: any) => err instanceof SpendLimitError && err.code === "spend_limit");
  assert.equal((await hold("c", 0.02)).amount, 0.02);
  // Exhausted: even zero-sized work is refused.
  await assert.rejects(hold("d", 0), (err: any) => err.code === "spend_limit");
  // Idempotent per key: a retry does not take a second hold.
  await hold("a", 0.03);
  close(await reserved(1), 0.05);
  assert.equal(await releaseReservation(1, "a", "done"), true);
  assert.equal(await releaseReservation(1, "a", "done"), false);
  close(await reserved(1), 0.02);

  rows.tenant_limits[0].hardLimit = false;
  const soft = await hold("e", 0.1);
  assert.equal(soft.warning, "over_soft_limit");
});

test("a tenant without a tenant_limits row has a $5 soft limit and is never refused; setting an amount keeps the flag", async () => {
  rows.tenant_limits = [];
  const state = await getBudgetState(1);
  assert.deepEqual([state.monthlyLimitUsd, state.hardLimit], [5, false]);
  rows.tenant_budget_periods = [{ id: 1, tenantId: 1, period: PERIOD, currency: "USD", committedAmount: "50.00000000", reservedAmount: "0" }];
  const over = await reserveBudget({ userId: 10, key: "no-row", amount: 1, source: "test", ttlMs: 60_000 });
  assert.equal(over.warning, "over_soft_limit");
  // Changing only the amount creates a soft row; changing it again never flips an existing flag.
  assert.equal((await api("PATCH", "/api/superadmin/costs/1/limit", SUPER, { monthlyLimitUsd: 20 })).status, 200);
  assert.equal(rows.tenant_limits[0].hardLimit, false);
  rows.tenant_limits[0].hardLimit = true;
  assert.equal((await api("PATCH", "/api/superadmin/costs/1/limit", SUPER, { monthlyLimitUsd: 30 })).status, 200);
  assert.equal(rows.tenant_limits[0].hardLimit, true);
});

test("budget state is fail-closed: unknown owners and storage errors refuse paid work", async () => {
  await assert.rejects(reserveBudget({ userId: 4242, key: "x", amount: 0, source: "test", ttlMs: 1000 }), (err: any) => err.code === "budget_unavailable");
  const original = db.transaction;
  db.transaction = async () => { throw new Error("connection refused for postgres://dialog_user:fake@db.internal.test/dialog"); };
  try {
    await assert.rejects(reserveBudget({ userId: 10, key: "y", amount: 0.01, source: "test", ttlMs: 1000 }), (err: any) => err.code === "budget_unavailable");
  } finally {
    db.transaction = original;
  }
  assert.ok(!emitted().includes("fake@db.internal.test"));
});

test("expired holds are released and call holds are settled once usage is recorded", async () => {
  rows.tenant_limits = [{ id: 1, tenantId: 1, monthlyLimitUsd: "1.00", hardLimit: true }];
  await reserveBudget({ userId: 10, key: "stale", amount: 0.9, source: "test", ttlMs: 1000, now: new Date(Date.now() - 60_000) });
  // The stale hold expired: a new reservation releases it first.
  await reserveBudget({ userId: 10, key: "fresh", amount: 0.5, source: "test", ttlMs: 60_000 });
  close(await reserved(1), 0.5);

  const call = await reserveCallBudget({ userId: 10, provider: "twilio", leg: "outbound", source: "dial", key: "call:1", callLogId: 1 });
  close(call.amount, 10 * 0.013);
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: 61, measurement: "actual" });
  await settleCall(1, "call_completed");
  assert.equal(rows.budget_reservations.find((r: any) => r.idempotencyKey === "call:1").status, "released");
  close(await reserved(1), 0.5);
  close(await committed(1), 0.026);
});

test("an active call is refused more time or another turn at the hard limit", async () => {
  rows.tenant_limits = [{ id: 1, tenantId: 1, monthlyLimitUsd: "0.20", hardLimit: true }];
  await reserveCallBudget({ userId: 10, provider: "twilio", leg: "outbound", source: "dial", key: "call:1", callLogId: 1 });
  // Ten minutes are held; at 4 minutes elapsed the 4 + 5 minute target is already covered.
  await extendCallHold({ id: 1, userId: 10, direction: "outbound" }, 240);
  await reserveTurnBudget({ userId: 10, callLogId: 1, turnId: "t1", estimate: { llmModels: ["gpt-4o-mini"], inputTokens: 4000, maxOutputTokens: 200 } });
  // At 20 minutes the hold must grow to 25 minutes (0.325), beyond the 0.20 limit.
  await assert.rejects(extendCallHold({ id: 1, userId: 10, direction: "outbound" }, 1200), (err: any) => err.code === "spend_limit");
  exhaust(1, 0.2);
  await assert.rejects(
    reserveTurnBudget({ userId: 10, callLogId: 1, turnId: "t2", estimate: { llmModels: ["gpt-4o-mini"], inputTokens: 4000, maxOutputTokens: 200 } }),
    (err: any) => err.code === "spend_limit",
  );
});

test("widget: free paths stay open over the limit; paid chat, TTS and voice are refused before any provider request", async () => {
  exhaust(1);
  assert.equal((await api("GET", `/widget/config/${widgetKey}`, null)).status, 200);
  aiBehavior.chatReply = "Fake reply";
  const chat = await api("POST", "/widget/chat", null, { apiKey: widgetKey, message: "hello" });
  assert.equal(chat.status, 402);
  assert.equal(chat.body.code, "spend_limit");
  assert.equal(typeof chat.body.reply, "string");
  assert.equal(chatRequests.length, 0);
  const tts = await api("POST", "/widget/tts", null, { apiKey: widgetKey, text: "hello" });
  assert.deepEqual([tts.status, tts.body.code], [402, "spend_limit"]);
  const voice = await api("POST", "/widget/voice-token", null, { apiKey: widgetKey });
  assert.deepEqual([voice.status, voice.body.code], [402, "spend_limit"]);
  assert.equal(ledger().length, 0);
  assert.equal((await api("POST", "/widget/tts", null, { text: "hello" })).status, 400, "anonymous TTS is refused");
});

test("widget chat usage is recorded in the ledger with reported tokens and its hold is released", async () => {
  aiBehavior.chatReply = "Fake reply";
  const chat = await api("POST", "/widget/chat", null, { apiKey: widgetKey, message: "hello there" });
  assert.equal(chat.status, 200);
  await until(() => (rows.budget_reservations ?? []).length > 0 && rows.budget_reservations.every((r: any) => r.status === "released"));
  const entries = ledger().filter((e: any) => e.source === "widget-chat" && e.category === "llm");
  assert.ok(entries.length >= 1);
  for (const entry of entries) {
    assert.equal(entry.measurement, "actual");
    assert.equal(entry.tenantId, 1);
    assert.equal(entry.status, "finalized");
  }
  close(await reserved(1), 0);
  assert.ok(!JSON.stringify(ledger()).includes("hello there"), "ledger stores no message text");
});

test("a request meter takes no hold unless paid work starts", async () => {
  exhaust(1);
  const meter = createRequestMeter({ userId: 10, source: "widget-chat", estimate: { llmModels: ["gpt-4o-mini"], inputTokens: 100 } });
  await meter.finish();
  assert.equal((rows.budget_reservations ?? []).length, 0);
  await assert.rejects(meter.ensureBudget(), (err: any) => err.code === "spend_limit");
});

// ── Invoices ─────────────────────────────────────────────────────────────

test("invoices are reproducible from finalized ledger entries; incomplete usage needs an explicit policy", async () => {
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: 61, measurement: "actual" });
  await recordUsage(llm("widget-llm", { source: "widget-chat" }));
  await recordUsage({ userId: 10, source: "test", category: "stt", provider: "sarvam", model: "saaras:v3", idempotencyKey: "unpriced", measurement: "estimated", unit: "audio_seconds", quantity: 5 });

  const refused = await api("POST", "/api/superadmin/invoices/generate", SUPER, { tenantId: 1, period: PERIOD });
  assert.equal(refused.status, 409);
  assert.deepEqual([refused.body.code, refused.body.needsReconciliation], ["usage_incomplete", 1]);
  assert.equal((rows.invoices ?? []).length, 0);

  const made = await api("POST", "/api/superadmin/invoices/generate", SUPER, { tenantId: 1, period: PERIOD, allowIncomplete: true });
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.entryCount, made.body.excludedIncomplete, made.body.callCount], [2, 1, 1]);
  const invoice = rows.invoices[0];
  const included = ledger().filter((e: any) => e.invoiceId === invoice.id);
  assert.equal(included.length, 2);
  close(invoice.totalRawCostUsd, included.reduce((s: number, e: any) => s + Number(e.platformCost), 0));
  close(invoice.totalBilledCostUsd, included.reduce((s: number, e: any) => s + Number(e.billableAmount), 0));
  assert.equal(invoice.currency, "USD");
  assert.equal(invoice.source, "ledger");
  assert.deepEqual(invoice.rateVersions, [(await currentRateCard()).version]);
  assert.equal(ledger().find((e: any) => e.idempotencyKey === "unpriced").invoiceId ?? null, null, "incomplete usage carries forward");
  const lines = rows.invoice_line_items;
  assert.deepEqual(lines.map((l: any) => l.description).sort(), ["Call #1", "widget-chat llm"].sort());
  assert.ok(lines.every((l: any) => l.phone === null));
  assert.equal(lines.find((l: any) => l.callLogId === 1).durationSeconds, 61);
  assert.ok(!JSON.stringify([rows.invoices, lines]).includes(PHONE));

  // Repeating generation cannot duplicate the invoice or its lines.
  const again = await api("POST", "/api/superadmin/invoices/generate", SUPER, { tenantId: 1, period: PERIOD, allowIncomplete: true });
  assert.equal(again.status, 409);
  assert.equal(rows.invoices.length, 1);
  assert.equal(rows.invoice_line_items.length, 2);
});

test("evidence arriving after invoicing becomes an adjustment entry; corrections are separate rows", async () => {
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: 125, measurement: "estimated", reason: "media_close" });
  const { invoice } = await generateLedgerInvoice({ tenantId: 1, period: PERIOD });
  const totalBefore = invoice.totalBilledCostUsd;
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: 61, measurement: "actual", reason: "provider_callback" });
  const [original, adjustment] = ledger();
  assert.equal(original.measurement, "estimated", "the invoiced entry is never rewritten");
  assert.equal(adjustment.entryType, "adjustment");
  assert.equal(adjustment.adjustsEntryId, original.id);
  close(adjustment.platformCost, 0.026 - 0.039);
  close(await committed(1), 0.026);
  assert.equal(rows.invoices[0].totalBilledCostUsd, totalBefore);
  await assert.rejects(generateLedgerInvoice({ tenantId: 1, period: PERIOD }), (err: any) => err instanceof InvoiceError && err.code === "invoice_exists");

  const bad = await api("POST", `/api/superadmin/invoices/${invoice.id}/adjustments`, SUPER, { billedAmountUsd: "5", reason: "x" });
  assert.equal(bad.status, 400);
  const ok = await api("POST", `/api/superadmin/invoices/${invoice.id}/adjustments`, SUPER, { billedAmountUsd: -0.01, reason: "Duplicate minute credit" });
  assert.equal(ok.status, 201);
  const view = await api("GET", `/api/invoices/${invoice.id}`, ADMIN_A);
  assert.equal(view.status, 200);
  assert.equal(view.body.adjustments.length, 1);
  assert.equal(view.body.adjustments[0].createdBy, undefined);
  close(view.body.adjustedTotalBilledCostUsd, Number(totalBefore) - 0.01);
});

test("overdue suspension uses the adjusted amount due: a fully credited invoice never suspends the tenant", async () => {
  const past = new Date(Date.now() - 86_400_000);
  const invoice = (id: number, tenantId: number) => ({
    id, tenantId, period: "2026-01", status: "sent", totalRawCostUsd: "8.000000", totalBilledCostUsd: "10.000000",
    commissionUsd: "2.000000", commissionPct: "20.00", dueDate: past, createdAt: past,
  });
  rows.invoices = [invoice(1, 1), invoice(2, 2)];
  rows.invoice_adjustments = [
    { id: 1, invoiceId: 1, tenantId: 1, rawAmountUsd: "0", billedAmountUsd: "-10.000000", reason: "Full credit", createdAt: past },
    { id: 2, invoiceId: 2, tenantId: 2, rawAmountUsd: "0", billedAmountUsd: "-4.000000", reason: "Partial credit", createdAt: past },
  ];
  await checkAndMarkOverdueInvoices();
  assert.deepEqual([rows.invoices[0].status, rows.tenants[0].status], ["sent", "active"]);
  assert.deepEqual([rows.invoices[1].status, rows.tenants[1].status], ["overdue", "suspended"]);
  // The suspended tenant is told the adjusted amount it owes.
  const blocked = await api("GET", "/api/invoices", ADMIN_B);
  assert.equal(blocked.status, 402);
  assert.deepEqual([blocked.body.invoiceId, blocked.body.amountDue], [2, "6.000000"]);
});

// ── Tenant isolation and administration ──────────────────────────────────

test("tenants see only their own invoices and usage; limits and rates are superadmin-only", async () => {
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: 61, measurement: "actual" });
  await recordCallTelephony(rows.call_logs[1], { provider: "twilio", seconds: 30, measurement: "actual" });
  const { invoice } = await generateLedgerInvoice({ tenantId: 1, period: PERIOD });

  assert.equal((await api("GET", `/api/invoices/${invoice.id}`, ADMIN_B)).status, 404);
  assert.deepEqual((await api("GET", "/api/invoices", ADMIN_B)).body.invoices, []);
  assert.equal((await api("GET", "/api/invoices", ADMIN_A)).body.invoices.length, 1);
  const usageB = await api("GET", "/api/usage/summary?tenantId=1", ADMIN_B);
  assert.equal(usageB.status, 200);
  close(usageB.body.committedUsd, 0.013);
  close(usageB.body.byCategory.telephony.billableUsd, 0.013);

  for (const [method, path, body] of [
    ["GET", "/api/superadmin/costs", undefined],
    ["PATCH", "/api/superadmin/costs/2/limit", { monthlyLimitUsd: 1000 }],
    ["PATCH", "/api/superadmin/costs/rates", { "telephony:twilio:outbound": 0 }],
    ["POST", "/api/superadmin/invoices/generate", { tenantId: 2, period: PERIOD }],
    ["GET", "/api/superadmin/usage/reconciliation", undefined],
  ] as const) {
    assert.equal((await api(method, path, ADMIN_A, body)).status, 403, path);
  }
  assert.equal((rows.tenant_limits ?? []).length, 0);
});

test("superadmin cost views, rate and limit changes, and reconciliation work from the ledger", async () => {
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: 61, measurement: "actual" });
  await recordCallTelephony(rows.call_logs[1], { provider: "exotel", seconds: 90, measurement: "estimated" });

  const costs = await api("GET", "/api/superadmin/costs", SUPER);
  assert.equal(costs.status, 200, costs.text);
  const a = costs.body.tenants.find((t: any) => t.tenantId === 1);
  close(a.telephonyCostUsd, 0.026);
  close(a.totalCostUsd, 0.026);
  assert.equal(costs.body.tenants.find((t: any) => t.tenantId === 2).unpricedEntries, 1);
  const detail = await api("GET", "/api/superadmin/costs/1", SUPER);
  assert.equal(detail.status, 200);
  close(detail.body.subtotals.telephony, 0.026);
  assert.equal(detail.body.trend.length, 6);
  assert.equal((await api("GET", "/api/superadmin/dashboard", SUPER)).status, 200);

  for (const body of [{ "made:up": 1 }, { "telephony:twilio:outbound": -1 }, { "telephony:twilio:outbound": "0.1" }, {}]) {
    assert.equal((await api("PATCH", "/api/superadmin/costs/rates", SUPER, body)).status, 400);
  }
  const rates = await api("PATCH", "/api/superadmin/costs/rates", SUPER, { "telephony:exotel:outbound": 0.01 });
  assert.equal(rates.status, 200);
  assert.equal(rates.body["telephony:exotel:outbound"], 0.01);

  for (const body of [{ monthlyLimitUsd: -1 }, { monthlyLimitUsd: "abc" }, { hardLimit: "yes" }]) {
    assert.equal((await api("PATCH", "/api/superadmin/costs/2/limit", SUPER, body)).status, 400);
  }
  assert.equal((await api("PATCH", "/api/superadmin/costs/2/limit", SUPER, { monthlyLimitUsd: 25, hardLimit: true })).status, 200);
  assert.deepEqual([rows.tenant_limits[0].monthlyLimitUsd, rows.tenant_limits[0].hardLimit], ["25.00", true]);

  const queue = await api("GET", "/api/superadmin/usage/reconciliation", SUPER);
  assert.equal(queue.body.entries.length, 1);
  const entry = queue.body.entries[0];
  assert.equal(entry.tenantId, 2);
  assert.equal(entry.phoneNumber, undefined);
  assert.equal((await api("POST", `/api/superadmin/usage/${entry.id}/resolve`, SUPER, { tenantId: 1, kind: "reprice" })).status, 404);
  assert.equal((await api("POST", `/api/superadmin/usage/${entry.id}/resolve`, SUPER, { tenantId: 2, kind: "billed_seconds", seconds: -5 })).status, 400);
  const resolved = await api("POST", `/api/superadmin/usage/${entry.id}/resolve`, SUPER, { tenantId: 2, kind: "billed_seconds", seconds: 90 });
  assert.deepEqual(resolved.body, { status: "finalized" });
  close(rows.call_logs[1].twilioCostUsd, 0.02);
  assert.equal((await api("GET", "/api/superadmin/usage/reconciliation", SUPER)).body.entries.length, 0);
});

test("ledger entries and billing errors carry no phone numbers, transcripts or secrets", async () => {
  await recordCallTelephony(rows.call_logs[0], { provider: "twilio", seconds: 61, measurement: "actual" });
  const scope = createUsageScope({ userId: 10, source: "media-stream", keyPrefix: "call:1:media", callLogId: 1 });
  await recordLlmCall(scope, { provider: "openai", model: "gpt-4o-mini", usage: null, promptTexts: [TRANSCRIPT, PHONE], outputText: TRANSCRIPT });
  const stored = JSON.stringify(ledger());
  assert.ok(!stored.includes(PHONE));
  assert.ok(!stored.includes(TRANSCRIPT));

  const original = db.transaction;
  db.transaction = async () => { throw new Error(`relation failed for ${PHONE} at postgres://dialog_user:fake-secret@db.internal.test/dialog`); };
  try {
    const res = await api("POST", "/api/superadmin/invoices/generate", SUPER, { tenantId: 1, period: PERIOD });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "Invoice request failed" });
  } finally {
    db.transaction = original;
  }
  const out = emitted();
  assert.ok(!out.includes("fake-secret"));
  assert.ok(!out.includes(PHONE));
});

import "./postgres-billing.test";
