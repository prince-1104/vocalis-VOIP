import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import express from "express";
import { rows, resetDatabase, db } from "./fake-db";
import { emitted, logs, resetLogs } from "./capture-logger";
import { safeErrorHandler } from "../src/lib/error-handler";
import { resolveUser, requireRole, signToken } from "../src/middleware/auth";
import campaignsRouter from "../src/routes/campaigns";
import suppressionsRouter from "../src/routes/suppressions";
import dialRouter from "../src/routes/dial";
import crmRouter from "../src/routes/crm";
import { completeCallLog } from "../src/routes/twilio";
import { sealCredential } from "../src/lib/credential-crypto";
import { resetRateLimitingForTests } from "../src/lib/rate-limit";
import {
  applyCampaignCallOutcome,
  claimNextCampaignContact,
  dialNextForCampaign,
  dispatchClaim,
  reconcileCampaignDispatches,
  triggerDialingForCampaign,
  DISPATCH_UNKNOWN_MS,
  MAX_ACTIVE_CALL_MS,
  STALE_CLAIM_MS,
} from "../src/lib/campaign-dialer";
import {
  callingWindowProblem,
  evaluateCallingWindow,
  isValidTimeZone,
  zonedWallTimeToUtc,
} from "../src/lib/calling-window";
import { normalizePhone, revokeSuppression } from "../src/lib/call-suppression";

after(() => {
  for (const timer of (globalThis as any).__dialogTestIntervals) clearInterval(timer);
});

const ORIGIN = "https://dialog.test";
const PHONE = { a1: "+15550100001", a2: "+15550100002", a3: "+15550100003", b9: "+15550100009", in: "09876543210" };
const EXOTEL_TOKEN_A = "fake-exotel-token-tenant-a";
const keyA = "dk_live_" + "a".repeat(64), keyB = "dk_live_" + "b".repeat(64), keyRead = "dk_live_" + "c".repeat(64);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const bearer = (tenantUserId: number, jti: string) => "Bearer " + signToken({ tenantUserId, jti } as any);
const ADMIN_A = bearer(100, "a".repeat(64));
const MANAGER_A = bearer(101, "b".repeat(64));
const ADMIN_B = bearer(200, "c".repeat(64));
const delay = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for test effect");
}

/** A zone whose local time is now between 02:00 and 20:00, so the windows below are deterministic. */
function zoneWithDaytime(): string {
  for (const zone of ["UTC", "Asia/Kolkata", "America/New_York", "Pacific/Auckland", "Asia/Tokyo"]) {
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(new Date()));
    if (hour >= 2 && hour < 20) return zone;
  }
  throw new Error("no daytime zone");
}
const ZONE = zoneWithDaytime();
const OPEN = { startTime: "00:00", endTime: "23:00", timezone: ZONE };
const CLOSED = { startTime: "21:00", endTime: "23:00", timezone: ZONE };

// Fake Exotel: every provider request is recorded; nothing leaves the process.
type ProviderMode = "ok" | "reject" | "server_error" | "network";
const provider = { mode: "ok" as ProviderMode, dialed: [] as string[], sids: 0 };
let realFetch: typeof fetch;

function campaign(id: number, userId: number, extra: Record<string, unknown> = {}) {
  return {
    id, userId, name: "Fake campaign", description: null, scriptId: null, status: "active",
    isAutomatic: false, dialParallel: false, maxConcurrentCalls: 1, maxRetries: 1, retryIntervalMinutes: 10,
    totalContacts: 0, calledCount: 0, answeredCount: 0, interestedCount: 0, transferConfig: null,
    createdAt: new Date(), updatedAt: new Date(), ...OPEN, ...extra,
  };
}
function link(id: number, campaignId: number, contactId: number, extra: Record<string, unknown> = {}) {
  return {
    id, campaignId, contactId, status: "pending", attempts: 0, lastAttemptAt: null, nextAttemptAt: null,
    claimToken: null, claimedAt: null, callLogId: null, createdAt: new Date(Date.now() - 600_000 + id * 1000), ...extra,
  };
}
const linkRow = (id: number) => rows.campaign_contacts.find((l: any) => l.id === id);
const campaignRow = (id: number) => rows.campaigns.find((c: any) => c.id === id);
const logRow = (id: number) => rows.call_logs.find((l: any) => l.id === id);

beforeEach(() => {
  resetDatabase();
  resetLogs();
  resetRateLimitingForTests();
  provider.mode = "ok";
  provider.dialed.length = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.exotel.com") return realFetch(input, init);
    provider.dialed.push(new URLSearchParams(String(init?.body)).get("From")!);
    if (provider.mode === "network") throw new TypeError("fetch failed");
    if (provider.mode === "reject")
      return new Response(JSON.stringify({ RestException: { Message: "Fake provider rejection", Code: 999 } }), { status: 400 });
    if (provider.mode === "server_error") return new Response("{}", { status: 503 });
    return new Response(JSON.stringify({ Call: { Sid: `fake-exotel-call-${++provider.sids}`, Status: "queued" } }), { status: 200 });
  }) as typeof fetch;

  rows.users = [{ id: 10 }, { id: 20 }];
  rows.tenants = [
    { id: 1, ownerId: 10, status: "active", slug: "a", telephonyType: "EXOTEL", commissionPct: "0" },
    { id: 2, ownerId: 20, status: "active", slug: "b", telephonyType: "EXOTEL", commissionPct: "0" },
  ];
  rows.exotel_configs = [1, 2].map((tenantId) => ({
    id: tenantId, tenantId, isEnabled: true, accountSid: `fake-exotel-account-${tenantId}`,
    apiKey: sealCredential("exotelApiKey", tenantId, `fake-exotel-key-${tenantId}`),
    apiToken: sealCredential("exotelApiToken", tenantId, tenantId === 1 ? EXOTEL_TOKEN_A : "fake-exotel-token-b"),
    exophone: "+15550109999", region: "singapore", appFlowUrl: "https://dialog.test/fake-flow",
  }));
  rows.agent_configs = [{ userId: 10, aiModel: "gpt-4o-mini", language: "en-US" }, { userId: 20, aiModel: "gpt-4o-mini" }];
  const member = (id: number, tenantId: number, role: string) =>
    ({ id, tenantId, userId: null, role, email: `member-${id}@example.test`, isActive: true, name: "Fake member" });
  rows.tenant_users = [member(100, 1, "admin"), member(101, 1, "manager"), member(200, 2, "admin")];
  rows.tenant_sessions = [
    [1, "a", 100, 1], [2, "b", 101, 1], [3, "c", 200, 2],
  ].map(([id, ch, tenantUserId, tenantId]) => ({
    id, token: String(ch).repeat(64), tenantUserId, tenantId, expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null,
  }));
  rows.crm_api_keys = [
    { id: 1, keyHash: hash(keyA), userId: 10, tenantId: 1, scopes: ["calls:read", "calls:write", "campaigns:read", "campaigns:write"], isActive: true },
    { id: 2, keyHash: hash(keyB), userId: 20, tenantId: 2, scopes: ["*", "calls:write"], isActive: true },
    { id: 3, keyHash: hash(keyRead), userId: 10, tenantId: 1, scopes: ["calls:read"], isActive: true },
  ];
  const contact = (id: number, userId: number, phone: string) =>
    ({ id, userId, phone, firstName: "Fake", lastName: `Contact${id}`, status: "pending" });
  rows.contacts = [contact(1, 10, PHONE.a1), contact(2, 10, PHONE.a2), contact(3, 10, PHONE.a3), contact(4, 10, PHONE.in), contact(9, 20, PHONE.b9)];
  rows.campaigns = [campaign(5, 10), campaign(6, 20)];
  rows.campaign_contacts = [link(1, 5, 1), link(2, 5, 2), link(3, 6, 9)];
  rows.call_logs = [];
  rows.call_suppressions = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function harness(t: any) {
  // Mirrors app.ts mount order for the routers under test.
  const app = express();
  app.use(express.json());
  app.use("/api", crmRouter);
  app.use("/api", resolveUser);
  app.use("/api", requireRole("manager", "admin"), campaignsRouter);
  app.use("/api", requireRole("manager", "admin"), suppressionsRouter);
  app.use("/api", requireRole("admin"), dialRouter);
  app.use(safeErrorHandler());
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return async (method: string, path: string, body?: unknown, auth = ADMIN_A) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", authorization: auth },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

// ── Ownership ────────────────────────────────────────────────────────────

test("campaign create and update reject contacts of another tenant before any state change", async (t) => {
  const api = await harness(t);
  for (const contactIds of [[1, 9], [1, 999], ["1"], [0], "1,2"]) {
    const res = await api("POST", "/api/campaigns", { name: "Fake", contactIds });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "contactIds must reference your own contacts." });
  }
  assert.equal(rows.campaigns.length, 2);

  const before = JSON.stringify(rows.campaign_contacts);
  const res = await api("PUT", "/api/campaigns/5", { name: "Renamed", contactIds: [1, 9] });
  assert.equal(res.status, 400);
  assert.equal(JSON.stringify(rows.campaign_contacts), before);
  assert.equal(campaignRow(5).name, "Fake campaign");

  // Another tenant's campaign is indistinguishable from a missing one.
  assert.deepEqual(await api("PUT", "/api/campaigns/6", { name: "Taken" }), { status: 404, body: { error: "Campaign not found" } });
  assert.deepEqual(await api("PUT", "/api/campaigns/999", { name: "Taken" }), { status: 404, body: { error: "Campaign not found" } });
  assert.equal(campaignRow(6).name, "Fake campaign");

  const listed = await api("GET", "/api/campaigns");
  assert.deepEqual(listed.body.map((c: any) => [c.id, c.contactIds]), [[5, [1, 2]]]);

  const created = await api("POST", "/api/campaigns", { name: "Own", contactIds: [1, 2, 2] });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.contactIds, [1, 2]);
  assert.deepEqual([created.body.startTime, created.body.endTime, created.body.timezone], ["09:00", "17:00", "Asia/Kolkata"]);
  assert.equal(provider.dialed.length, 0);
});

test("campaign edits keep attempt history and never drop a link with a call in flight", async (t) => {
  const api = await harness(t);
  Object.assign(linkRow(1), { status: "calling", attempts: 1, callLogId: 77 });
  Object.assign(linkRow(2), { status: "retrying", attempts: 1 });
  const res = await api("PUT", "/api/campaigns/5", { contactIds: [2, 3] });
  assert.equal(res.status, 200);
  assert.equal(linkRow(1).status, "calling");
  assert.equal(linkRow(2).attempts, 1);
  assert.deepEqual(rows.campaign_contacts.filter((l: any) => l.campaignId === 5).map((l: any) => l.contactId).sort(), [1, 2, 3]);
  assert.equal(campaignRow(5).totalContacts, 2);
});

test("dial endpoints reject another tenant's campaign or contact before any provider request", async (t) => {
  const api = await harness(t);
  const crm = (path: string, body: unknown, key = keyA) => api("POST", path, body, `Bearer ${key}`);
  assert.equal((await api("POST", "/api/contacts/9/dial", {})).status, 404);
  for (const campaignId of [6, 999, "6", "abc", -1]) {
    assert.deepEqual(await api("POST", "/api/contacts/1/dial", { campaignId }), { status: 404, body: { error: "Campaign not found" } });
    assert.deepEqual(await crm("/api/crm/calls", { phone: PHONE.a1, campaignId }), { status: 404, body: { error: "Campaign not found" } });
  }
  assert.equal((await api("POST", "/api/campaigns/6/dial-next", {})).body.error, "Campaign not found");
  assert.equal((await crm("/api/crm/campaigns/6/start", {})).status, 404);
  assert.equal(provider.dialed.length, 0);
  assert.equal(rows.call_logs.length, 0);
  assert.equal(linkRow(3).attempts, 0);

  const placed = await api("POST", "/api/contacts/1/dial", { campaignId: 5 });
  assert.equal(placed.status, 200);
  assert.deepEqual(provider.dialed, [PHONE.a1]);
  assert.equal(logRow(placed.body.callLogId).campaignId, 5);
});

test("a campaign link to a contact the campaign tenant does not own is never dialed", async () => {
  rows.campaign_contacts.unshift(link(10, 5, 9, { createdAt: new Date(0) }));
  const result = await dialNextForCampaign(5, 10, ORIGIN);
  assert.equal(result.contact?.id, 1);
  assert.equal(linkRow(10).status, "invalid_contact");
  assert.deepEqual(provider.dialed, [PHONE.a1]);
  assert.equal(await dialNextForCampaign(5, 20, ORIGIN).catch((err) => err.message), "Campaign not found");
});

// ── Atomic claims ────────────────────────────────────────────────────────

test("concurrent dial-next requests claim and dial a contact at most once", async () => {
  rows.campaign_contacts = [link(1, 5, 1)];
  const results = await Promise.all(Array.from({ length: 6 }, () => dialNextForCampaign(5, 10, ORIGIN)));
  assert.deepEqual(provider.dialed, [PHONE.a1]);
  assert.equal(results.filter((r) => r.callSid).length, 1);
  assert.deepEqual([linkRow(1).status, linkRow(1).attempts], ["calling", 1]);
  assert.equal(campaignRow(5).calledCount, 1);

  rows.campaign_contacts = [link(2, 5, 2)];
  const claims = await Promise.all(Array.from({ length: 5 }, () => claimNextCampaignContact(5, 10)));
  assert.equal(claims.filter((c) => c.kind === "claimed").length, 1);
});

test("the concurrency limit holds and counters use atomic increments", async () => {
  rows.campaign_contacts.push(link(4, 5, 3));
  assert.equal((await dialNextForCampaign(5, 10, ORIGIN)).contact?.id, 1);
  const waiting = await dialNextForCampaign(5, 10, ORIGIN);
  assert.equal(waiting.waiting, true);
  assert.equal(provider.dialed.length, 1);

  Object.assign(campaignRow(5), { dialParallel: true, maxConcurrentCalls: 2 });
  // The campaign row read by each dispatch is stale; the stored counter still advances per call.
  await dialNextForCampaign(5, 10, ORIGIN);
  assert.equal((await dialNextForCampaign(5, 10, ORIGIN)).waiting, true);
  assert.equal(provider.dialed.length, 2);
  assert.equal(campaignRow(5).calledCount, 2);
});

test("concurrent start and rerun produce one dial, and rerun refuses while calls are in flight", async (t) => {
  const api = await harness(t);
  rows.campaign_contacts = [link(1, 5, 1)];
  Object.assign(campaignRow(5), { status: "paused", isAutomatic: true });
  const [start, rerun] = await Promise.all([
    api("POST", "/api/campaigns/5/start", {}),
    api("POST", "/api/campaigns/5/rerun", { autoStart: true }),
  ]);
  assert.ok([start.status, rerun.status].includes(200));
  await until(() => provider.dialed.length >= 1 && linkRow(1).status === "calling");
  await delay(100);
  assert.deepEqual(provider.dialed, [PHONE.a1]);
  assert.equal(linkRow(1).attempts, 1);

  campaignRow(5).status = "paused";
  const res = await api("POST", "/api/campaigns/5/rerun", { autoStart: true });
  assert.equal(res.status, 409);
  assert.deepEqual([linkRow(1).status, linkRow(1).attempts, campaignRow(5).status, campaignRow(5).calledCount], ["calling", 1, "paused", 1]);
  assert.equal(provider.dialed.length, 1);
});

test("duplicate and racing finalizations advance the link and answered counter once", async () => {
  const first = await dialNextForCampaign(5, 10, ORIGIN);
  await Promise.all([
    completeCallLog(first.callLogId!, "completed", 30, ORIGIN),
    completeCallLog(first.callLogId!, "completed", 30, ORIGIN),
    applyCampaignCallOutcome(logRow(first.callLogId!), "answered"),
  ]);
  assert.equal(linkRow(1).status, "answered");
  assert.equal(campaignRow(5).answeredCount, 1);
  assert.equal(await applyCampaignCallOutcome(logRow(first.callLogId!), "answered"), false);

  // Callback racing reconciliation of a lost callback: one finalization, one transition.
  const second = await dialNextForCampaign(5, 10, ORIGIN);
  await Promise.all([
    completeCallLog(second.callLogId!, "no-answer", 0),
    reconcileCampaignDispatches(5, new Date(Date.now() + MAX_ACTIVE_CALL_MS + 60_000)),
  ]);
  assert.equal(linkRow(2).status, "retrying");
  assert.equal(linkRow(2).attempts, 1);
  assert.equal(campaignRow(5).answeredCount, 1);

  // A late callback for an earlier attempt cannot move the current attempt.
  linkRow(2).nextAttemptAt = new Date(0);
  const third = await dialNextForCampaign(5, 10, ORIGIN);
  assert.equal(third.contact?.id, 2);
  logRow(second.callLogId!).finalizedAt = null;
  await completeCallLog(second.callLogId!, "completed", 12);
  assert.deepEqual([linkRow(2).status, linkRow(2).callLogId], ["calling", third.callLogId]);
  assert.equal(campaignRow(5).answeredCount, 1);
});

// ── Provider failures and recovery ───────────────────────────────────────

test("a definite provider rejection closes the attempt and schedules a retry without redialing now", async () => {
  rows.campaign_contacts = [link(1, 5, 1)];
  provider.mode = "reject";
  const result = await dialNextForCampaign(5, 10, ORIGIN);
  assert.equal(result.dialFailed, true);
  assert.deepEqual([linkRow(1).status, linkRow(1).attempts], ["retrying", 1]);
  assert.ok(linkRow(1).nextAttemptAt > new Date());
  assert.ok(logRow(result.callLogId!).finalizedAt instanceof Date);
  assert.equal(campaignRow(5).calledCount, 0);
  provider.mode = "ok";
  assert.equal((await dialNextForCampaign(5, 10, ORIGIN)).callSid, undefined);
  assert.equal(provider.dialed.length, 1);
});

for (const mode of ["server_error", "network"] as const) {
  test(`an ambiguous provider outcome (${mode}) is held for reconciliation, never redialed blindly`, async () => {
    rows.campaign_contacts = [link(1, 5, 1)];
    provider.mode = mode;
    const result = await dialNextForCampaign(5, 10, ORIGIN);
    assert.equal(result.dialFailed, true);
    assert.equal(linkRow(1).status, "dispatch_unknown");
    assert.equal(logRow(result.callLogId!).endedAt, undefined);
    provider.mode = "ok";
    assert.equal((await dialNextForCampaign(5, 10, ORIGIN)).waiting, true);
    await reconcileCampaignDispatches(5, new Date(Date.now() + 60_000));
    assert.equal(linkRow(1).status, "dispatch_unknown");
    assert.equal(provider.dialed.length, 1);

    await reconcileCampaignDispatches(5, new Date(Date.now() + DISPATCH_UNKNOWN_MS + 60_000));
    assert.equal(linkRow(1).status, "retrying");
    assert.equal(logRow(result.callLogId!).outcome, "no_answer");
    assert.ok(logRow(result.callLogId!).finalizedAt instanceof Date);
    // A callback that arrives after all lost the finalization claim and changes nothing.
    await completeCallLog(result.callLogId!, "completed", 40);
    assert.equal(campaignRow(5).answeredCount, 0);
    assert.equal(provider.dialed.length, 1);
  });
}

// ── Spending limits (Phase 1L) ───────────────────────────────────────────

function exhaustTenantA() {
  const period = new Date().toISOString().slice(0, 7);
  rows.tenant_limits = [{ id: 1, tenantId: 1, monthlyLimitUsd: "1.00", hardLimit: true }];
  rows.tenant_budget_periods = [{ id: 1, tenantId: 1, period, currency: "USD", committedAmount: "1.00000000", reservedAmount: "0" }];
}

test("campaign workers and direct dials enforce the same hard limit before any call log or provider request", async (t) => {
  const api = await harness(t);
  exhaustTenantA();
  const dial = await api("POST", "/api/contacts/1/dial", {});
  assert.deepEqual([dial.status, dial.body.reason], [402, "spend_limit"]);
  const crm = await api("POST", "/api/crm/calls", { phone: PHONE.a1 }, `Bearer ${keyA}`);
  assert.deepEqual([crm.status, crm.body.reason], [402, "spend_limit"]);
  const worker = await dialNextForCampaign(5, 10, ORIGIN);
  assert.equal(worker.budgetBlocked, true);
  // Refused before the claim counted: no attempt, no call log, no provider request.
  assert.deepEqual([linkRow(1).status, linkRow(1).attempts, linkRow(1).claimToken], ["pending", 0, null]);
  assert.equal(rows.call_logs.length, 0);
  assert.equal(provider.dialed.length, 0);
  assert.equal((rows.budget_reservations ?? []).length, 0);
  // Another tenant's budget is independent.
  assert.equal((await dialNextForCampaign(6, 20, ORIGIN)).contact?.id, 9);
  assert.deepEqual(provider.dialed, [PHONE.b9]);
});

test("ambiguous dispatch usage stays in reconciliation; a late callback fills it in without a duplicate charge", async () => {
  rows.campaign_contacts = [link(1, 5, 1)];
  provider.mode = "server_error";
  const result = await dialNextForCampaign(5, 10, ORIGIN);
  const usage = () => (rows.usage_ledger ?? []).filter((e: any) => e.callLogId === result.callLogId);
  assert.equal(usage().length, 1);
  assert.deepEqual([usage()[0].status, usage()[0].statusReason, usage()[0].quantity ?? null], ["needs_reconciliation", "quantity_unknown", null]);
  assert.ok(rows.budget_reservations.every((r: any) => r.status === "released"));

  await reconcileCampaignDispatches(5, new Date(Date.now() + DISPATCH_UNKNOWN_MS + 60_000));
  assert.equal(usage().length, 1, "reconciliation does not add a second charge");
  await completeCallLog(result.callLogId!, "completed", 40, ORIGIN, "unverified_callback");
  assert.equal(usage().length, 1);
  // Exotel has no configured rate: the duration is now known, the cost is not, and it is not zero.
  assert.deepEqual([usage()[0].measurement, Number(usage()[0].quantity), usage()[0].platformCost ?? null], ["estimated", 40, null]);
  assert.match(usage()[0].statusReason, /^missing_rate:/);
  assert.equal(logRow(result.callLogId!).estimatedCostUsd ?? null, null);
  assert.equal(provider.dialed.length, 1);
});

test("an unsigned Exotel no-answer callback leaves telephony usage in reconciliation, not a zero-cost final entry", async () => {
  rows.campaign_contacts = [link(1, 5, 1)];
  const result = await dialNextForCampaign(5, 10, ORIGIN);
  await completeCallLog(result.callLogId!, "no-answer", 0, ORIGIN, "unverified_callback");
  await completeCallLog(result.callLogId!, "no-answer", 0, ORIGIN, "unverified_callback");
  const usage = (rows.usage_ledger ?? []).filter((e: any) => e.callLogId === result.callLogId);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].status, "needs_reconciliation");
  assert.equal(usage[0].finalizedAt ?? null, null);
  assert.equal(linkRow(1).status, "retrying");
  assert.ok(rows.budget_reservations.every((r: any) => r.status === "released"));
});

test("a worker crash after claiming releases the contact without counting an attempt", async () => {
  rows.campaign_contacts = [link(1, 5, 1)];
  const claim = await claimNextCampaignContact(5, 10);
  assert.equal(claim.kind, "claimed");
  assert.equal((await dialNextForCampaign(5, 10, ORIGIN)).waiting, true);
  await reconcileCampaignDispatches(5, new Date(Date.now() + 30_000));
  assert.equal(linkRow(1).status, "dialing");
  await reconcileCampaignDispatches(5, new Date(Date.now() + STALE_CLAIM_MS + 1000));
  assert.deepEqual([linkRow(1).status, linkRow(1).attempts, linkRow(1).claimToken], ["pending", 0, null]);
  assert.equal(provider.dialed.length, 0);
  // The stale claim token can no longer bind or advance the link.
  if (claim.kind === "claimed") assert.equal((await dispatchClaim(claim.claim, ORIGIN)).kind, "released");
  assert.equal(provider.dialed.length, 0);
  assert.equal((await dialNextForCampaign(5, 10, ORIGIN)).contact?.id, 1);
  assert.deepEqual(provider.dialed, [PHONE.a1]);
});

test("an accepted call whose terminal callback never arrives is closed after the horizon", async () => {
  rows.campaign_contacts = [link(1, 5, 1)];
  const placed = await dialNextForCampaign(5, 10, ORIGIN);
  await reconcileCampaignDispatches(5, new Date(Date.now() + 60 * 60_000));
  assert.equal(linkRow(1).status, "calling");
  await reconcileCampaignDispatches(5, new Date(Date.now() + MAX_ACTIVE_CALL_MS + 60_000));
  assert.equal(linkRow(1).status, "retrying");
  assert.ok(logRow(placed.callLogId!).finalizedAt instanceof Date);
  assert.equal(provider.dialed.length, 1);
});

// ── Calling windows ──────────────────────────────────────────────────────

test("calling windows are evaluated in the campaign time zone, not UTC", () => {
  const ist = { startTime: "09:00", endTime: "17:00", timezone: "Asia/Kolkata" };
  const at = (iso: string, config = ist) => evaluateCallingWindow(config, new Date(iso));
  assert.deepEqual(at("2026-01-15T03:29:00Z"), { status: "closed", opensAt: new Date("2026-01-15T03:30:00Z") });
  assert.deepEqual(at("2026-01-15T03:45:00Z"), { status: "open", closesAt: new Date("2026-01-15T11:30:00Z") });
  assert.equal(at("2026-01-15T03:45:00Z", { ...ist, timezone: "UTC" }).status, "closed");
  // The last DISPATCH_SAFETY_MARGIN_MINUTES (5) before close start no new calls.
  assert.equal(at("2026-01-15T11:24:00Z").status, "open");
  assert.deepEqual(at("2026-01-15T11:25:00Z"), { status: "closed", opensAt: new Date("2026-01-16T03:30:00Z") });
});

test("calling windows follow DST transitions", () => {
  const ny = { startTime: "09:00", endTime: "17:00", timezone: "America/New_York" };
  const at = (iso: string) => evaluateCallingWindow(ny, new Date(iso));
  assert.equal(at("2026-01-15T13:30:00Z").status, "closed");
  assert.equal(at("2026-07-15T13:30:00Z").status, "open");
  // Evening before spring-forward: next open is 09:00 EDT (13:00Z), not 14:00Z.
  assert.deepEqual(at("2026-03-07T23:00:00Z"), { status: "closed", opensAt: new Date("2026-03-08T13:00:00Z") });
  // Nonexistent local time moves forward by the gap; repeated local time uses its first occurrence.
  assert.deepEqual(zonedWallTimeToUtc(2026, 3, 8, 150, "America/New_York"), new Date("2026-03-08T07:30:00Z"));
  assert.deepEqual(zonedWallTimeToUtc(2026, 11, 1, 90, "America/New_York"), new Date("2026-11-01T05:30:00Z"));
  assert.equal(at("2026-11-01T13:59:00Z").status, "closed");
  assert.equal(at("2026-11-01T14:00:00Z").status, "open");
});

test("invalid or missing window configuration fails safe", () => {
  const ok = { startTime: "09:00", endTime: "17:00", timezone: "Asia/Kolkata" };
  assert.equal(callingWindowProblem(ok), null);
  for (const bad of [
    { ...ok, startTime: "9:00" }, { ...ok, endTime: "24:00" }, { ...ok, startTime: null },
    { ...ok, startTime: "17:00", endTime: "09:00" }, { ...ok, endTime: "09:04" },
    { ...ok, timezone: "Mars/Olympus" }, { ...ok, timezone: "+05:30" }, { ...ok, timezone: "" }, { ...ok, timezone: null },
  ]) {
    assert.ok(callingWindowProblem(bad as any), JSON.stringify(bad));
    assert.equal(evaluateCallingWindow(bad as any, new Date()).status, "invalid");
  }
  assert.ok(isValidTimeZone("Asia/Kolkata") && isValidTimeZone("Asia/Calcutta") && isValidTimeZone("UTC"));
});

test("outside the window contacts stay queued and repeated polling consumes nothing", async (t) => {
  const api = await harness(t);
  Object.assign(campaignRow(5), CLOSED);
  linkRow(2).status = "retrying";
  linkRow(2).attempts = 1;
  linkRow(2).nextAttemptAt = new Date(0);
  for (let i = 0; i < 3; i++) {
    const res = await api("POST", "/api/campaigns/5/dial-next", {});
    assert.equal(res.status, 200);
    assert.equal(res.body.deferred, true);
    assert.ok(new Date(res.body.nextWindowAt) > new Date());
  }
  campaignRow(5).isAutomatic = true;
  await triggerDialingForCampaign(5, 10, ORIGIN);
  assert.deepEqual([linkRow(1).status, linkRow(1).attempts, linkRow(2).status, linkRow(2).attempts], ["pending", 0, "retrying", 1]);
  assert.equal(campaignRow(5).status, "active");
  assert.equal(provider.dialed.length, 0);
});

test("a window that closes between claim and dispatch releases the claim", async () => {
  const claim = await claimNextCampaignContact(5, 10);
  assert.equal(claim.kind, "claimed");
  Object.assign(campaignRow(5), CLOSED);
  if (claim.kind === "claimed") assert.equal((await dispatchClaim(claim.claim, ORIGIN)).kind, "released");
  assert.deepEqual([linkRow(1).status, linkRow(1).attempts, linkRow(1).claimToken], ["pending", 0, null]);
  assert.equal(provider.dialed.length + rows.call_logs.length, 0);
});

test("window configuration is validated on save and invalid stored configuration blocks dialing", async (t) => {
  const api = await harness(t);
  for (const body of [{ startTime: "25:00" }, { timezone: "Mars/Olympus" }, { startTime: "18:00", endTime: "08:00" }]) {
    assert.equal((await api("POST", "/api/campaigns", { name: "Fake", ...body })).status, 400);
    assert.equal((await api("PUT", "/api/campaigns/5", body)).status, 400);
    assert.equal((await api("POST", "/api/crm/campaigns", { name: "Fake", contacts: [{ phone: PHONE.a1 }], ...body }, `Bearer ${keyA}`)).status, 400);
  }
  assert.equal(rows.campaigns.length, 2);
  assert.equal(campaignRow(5).startTime, "00:00");

  Object.assign(campaignRow(5), { startTime: null, status: "paused", isAutomatic: true });
  const start = await api("POST", "/api/campaigns/5/start", {});
  assert.equal(start.status, 400);
  assert.match(start.body.error, /Calling window is not configured correctly/);
  assert.equal(campaignRow(5).status, "paused");

  campaignRow(5).status = "active";
  const next = await api("POST", "/api/campaigns/5/dial-next", {});
  assert.equal(next.status, 400);
  assert.match(next.body.error, /Calling window is not configured correctly/);
  await triggerDialingForCampaign(5, 10, ORIGIN);
  await triggerDialingForCampaign(5, 10, ORIGIN);
  assert.equal(logs.filter((l) => l.msg === "Campaign not dialing: invalid calling window").length, 1);
  assert.equal(provider.dialed.length, 0);
  assert.equal(linkRow(1).attempts, 0);
});

// ── Opt-out / do-not-call ────────────────────────────────────────────────

test("phone normalization matches formatting variants and rejects junk", () => {
  for (const raw of ["+91 98765 43210", "098765-43210", "9876543210", "919876543210", "0091 9876543210", "tel:+919876543210", "(+91) 98765.43210"])
    assert.deepEqual(normalizePhone(raw), { phone: "+919876543210", key: "9876543210" }, raw);
  assert.deepEqual(normalizePhone("+1 (555) 010-0001"), { phone: "+15550100001", key: "5550100001" });
  for (const raw of ["12345", "abc", "", "+", "98765x43210", 9876543210, null]) assert.equal(normalizePhone(raw as any), null);
});

test("opt-outs are idempotent, tenant scoped and block manual, raw and CRM dials", async (t) => {
  const api = await harness(t);
  const crm = (path: string, body: unknown, key = keyA) => api("POST", path, body, `Bearer ${key}`);
  const first = await crm("/api/crm/opt-outs", { phone: "98765 43210" });
  assert.equal(first.status, 201);
  const again = await crm("/api/crm/opt-outs", { phone: "+91-98765-43210", reason: "opt_out" });
  assert.deepEqual([again.status, again.body.id], [200, first.body.id]);
  assert.equal(rows.call_suppressions.length, 1);
  assert.equal((await crm("/api/crm/opt-outs", { phone: "123" })).status, 400);
  assert.equal((await crm("/api/crm/opt-outs", { phone: PHONE.a1, reason: "consent" })).status, 400);
  assert.equal((await crm("/api/crm/opt-outs", { phone: PHONE.a1 }, keyRead)).status, 403);

  const blocked = { error: "This number has opted out or is on the do-not-call list.", reason: "suppressed" };
  assert.deepEqual(await api("POST", "/api/contacts/4/dial", {}), { status: 403, body: blocked });
  assert.deepEqual(await api("POST", "/api/dial/phone", { phone: "+919876543210" }), { status: 403, body: blocked });
  assert.deepEqual(await crm("/api/crm/calls", { phone: "0 98765 43210" }), { status: 403, body: blocked });
  assert.equal(provider.dialed.length + rows.call_logs.length, 0);

  // Tenant B is unaffected by tenant A's list and cannot remove tenant A's record.
  assert.equal((await crm("/api/crm/calls", { phone: PHONE.in }, keyB)).status, 200);
  assert.deepEqual(provider.dialed, [PHONE.in]);
  assert.equal((await api("DELETE", `/api/suppressions/${first.body.id}`, undefined, ADMIN_B)).status, 404);
  assert.equal(await revokeSuppression(20, first.body.id), false);
  assert.equal((await api("DELETE", `/api/suppressions/${first.body.id}`, undefined, MANAGER_A)).status, 403);
  assert.equal(rows.call_suppressions[0].revokedAt, null);
  assert.deepEqual((await api("GET", "/api/suppressions", undefined, ADMIN_B)).body, []);

  assert.equal((await api("DELETE", `/api/suppressions/${first.body.id}`)).status, 204);
  assert.equal((await api("POST", "/api/contacts/4/dial", {})).status, 200);
  // Re-adding after removal reactivates the same record.
  const readded = await api("POST", "/api/suppressions", { phone: PHONE.in }, MANAGER_A);
  assert.deepEqual([readded.status, readded.body.id, rows.call_suppressions.length], [201, first.body.id, 1]);
});

test("campaign, retry and rerun dials re-check opt-outs recorded after queueing", async (t) => {
  const api = await harness(t);
  rows.campaign_contacts.push(link(4, 5, 3));
  assert.equal((await api("POST", "/api/suppressions", { phone: PHONE.a1 })).status, 201);
  const skipped = await dialNextForCampaign(5, 10, ORIGIN);
  assert.equal(skipped.dialFailed, true);
  assert.deepEqual([linkRow(1).status, linkRow(1).attempts], ["suppressed", 0]);
  assert.equal(provider.dialed.length, 0);

  // Retry path: contact 2 was dialed, did not answer, then opted out.
  Object.assign(campaignRow(5), { dialParallel: true, maxConcurrentCalls: 3 });
  const placed = await dialNextForCampaign(5, 10, ORIGIN);
  assert.equal(placed.contact?.id, 2);
  await completeCallLog(placed.callLogId!, "no-answer", 0);
  linkRow(2).nextAttemptAt = new Date(0);
  assert.equal((await api("POST", "/api/crm/opt-outs", { phone: PHONE.a2 }, `Bearer ${keyA}`)).status, 201);
  await dialNextForCampaign(5, 10, ORIGIN);
  assert.equal(linkRow(2).status, "suppressed");
  assert.equal((await dialNextForCampaign(5, 10, ORIGIN)).contact?.id, 3);
  assert.deepEqual(provider.dialed, [PHONE.a2, PHONE.a3]);

  // Rerun resets links, and the suppression still applies before dispatch.
  await completeCallLog(rows.call_logs.at(-1).id, "completed", 10);
  campaignRow(5).status = "completed";
  assert.equal((await api("POST", "/api/campaigns/5/rerun", {})).status, 200);
  campaignRow(5).status = "active";
  for (let i = 0; i < 4; i++) await dialNextForCampaign(5, 10, ORIGIN);
  assert.deepEqual(provider.dialed, [PHONE.a2, PHONE.a3, PHONE.a3]);
  assert.deepEqual([linkRow(1).status, linkRow(2).status], ["suppressed", "suppressed"]);
});

test("an unavailable suppression store blocks every dial and releases campaign claims", async (t) => {
  const api = await harness(t);
  const original = db.query.callSuppressionsTable.findFirst;
  db.query.callSuppressionsTable.findFirst = async () => {
    throw new Error("connection terminated");
  };
  t.after(() => {
    db.query.callSuppressionsTable.findFirst = original;
  });
  const res = await api("POST", "/api/contacts/1/dial", {});
  assert.deepEqual([res.status, res.body.reason], [503, "suppression_unavailable"]);
  assert.equal((await api("POST", "/api/crm/calls", { phone: PHONE.a1 }, `Bearer ${keyA}`)).status, 503);
  const result = await dialNextForCampaign(5, 10, ORIGIN);
  assert.deepEqual([result.done, result.dialFailed], [true, true]);
  assert.deepEqual([linkRow(1).status, linkRow(1).attempts, linkRow(1).claimToken], ["pending", 0, null]);
  assert.equal(provider.dialed.length + rows.call_logs.length, 0);
});

test("an opt-out during an active call does not hang up but blocks every later attempt", async (t) => {
  const api = await harness(t);
  rows.campaign_contacts = [link(1, 5, 1)];
  const placed = await dialNextForCampaign(5, 10, ORIGIN);
  assert.equal((await api("POST", "/api/suppressions", { phone: PHONE.a1 })).status, 201);
  assert.equal(logRow(placed.callLogId!).endedAt, undefined);
  await completeCallLog(placed.callLogId!, "no-answer", 0);
  linkRow(1).nextAttemptAt = new Date(0);
  await dialNextForCampaign(5, 10, ORIGIN);
  assert.equal(linkRow(1).status, "suppressed");
  assert.equal(provider.dialed.length, 1);
});

test("dispatch logs carry no phone numbers or provider credentials", async (t) => {
  const api = await harness(t);
  await api("POST", "/api/crm/opt-outs", { phone: PHONE.in }, `Bearer ${keyA}`);
  await api("POST", "/api/contacts/4/dial", {});
  rows.campaign_contacts.push(link(4, 5, 4, { createdAt: new Date(0) }));
  await dialNextForCampaign(5, 10, ORIGIN);
  provider.mode = "reject";
  Object.assign(campaignRow(5), { dialParallel: true, maxConcurrentCalls: 5 });
  await dialNextForCampaign(5, 10, ORIGIN);
  provider.mode = "server_error";
  await dialNextForCampaign(5, 10, ORIGIN);
  const out = emitted();
  assert.ok(out.length > 0);
  for (const secret of ["5550100", "9876543210", "98765", EXOTEL_TOKEN_A, "fake-exotel-key-1", keyA])
    assert.equal(out.includes(secret), false, secret);
});

import "./postgres-campaign-dispatch.test";
