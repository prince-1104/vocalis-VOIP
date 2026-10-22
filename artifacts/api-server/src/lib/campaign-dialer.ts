import { db, agentConfigsTable, callLogsTable, contactsTable, campaignsTable, campaignContactsTable } from "@workspace/db";
import type { Campaign } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";
import { buildCallCrmMetadataForCampaign } from "./campaign-transfer";
import { evaluateCallingWindow } from "./calling-window";
import { DialBlockedError } from "./call-suppression";
import { claimCallFinalization } from "./transfer-slots";
import {
  placeOutboundCall,
  ProviderDispatchError,
  TelephonyNotConfiguredError,
} from "./telephony/place-outbound-call";
import { SpendLimitError } from "./billing/spend-budget";
import { outboundTelephonyProvider, recordCallTelephony, settleCall } from "./billing/call-usage";
import { callHoldMinutes, telephonyHold } from "./billing/estimates";

type Connection = typeof db;
type CampaignContact = typeof campaignContactsTable.$inferSelect;

/**
 * campaign_contacts.status state machine:
 *   pending | retrying  --claim-->  dialing  --provider accepted-->  calling
 *   dialing  --provider rejected (4xx)-->  retrying | failed
 *   dialing  --provider outcome unknown-->  dispatch_unknown
 *   calling | dispatch_unknown  --call finalized-->  answered | retrying | failed
 *   dialing  --suppressed before dispatch-->  suppressed (terminal)
 *   pending | retrying  --contact not owned by campaign tenant-->  invalid_contact (terminal)
 * Every transition is a conditional update on the observed state (and claim
 * token), so concurrent workers, callbacks and reconciliation cannot both win.
 */
export const IN_FLIGHT_STATUSES = ["dialing", "calling", "dispatch_unknown"] as const;
export const DIALABLE_STATUSES = ["pending", "retrying"] as const;
const TERMINAL_STATUSES = new Set(["answered", "failed", "suppressed", "invalid_contact"]);
const IN_FLIGHT = new Set<string>(IN_FLIGHT_STATUSES);

/** Claimed but never reached call-log creation (worker crashed before dispatch). */
export const STALE_CLAIM_MS = 2 * 60_000;
/** Call log exists with no provider call ID: the provider request outcome is unknown. */
export const DISPATCH_UNKNOWN_MS = 30 * 60_000;
/** Upper bound on a call that never received a terminal callback. */
export const MAX_ACTIVE_CALL_MS = 6 * 60 * 60_000;
/** Grace for the status callback after a call is marked ended. */
export const ENDED_GRACE_MS = 60_000;
const CLAIM_SCAN_LIMIT = 25;
/** Advisory-lock namespace serializing claims per campaign (pg_advisory_xact_lock(ns, campaignId)). */
const CLAIM_LOCK_NAMESPACE = 727_301;

function getCampaignBaseUrl(): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    return `https://${domains.split(",")[0].trim()}`;
  }
  return process.env.PUBLIC_BASE_URL || "https://dialog.noeticminds.com";
}

export interface DialNextResult {
  done: boolean;
  dialFailed?: boolean;
  /** Outside the calling window; nothing was claimed. */
  deferred?: boolean;
  nextWindowAt?: string;
  /** Every concurrent-call slot for the campaign is busy. */
  waiting?: boolean;
  /** The tenant's spend limit refused the call; nothing was claimed or dialed. */
  budgetBlocked?: boolean;
  error?: string;
  message?: string;
  callSid?: string;
  callLogId?: number;
  contact?: {
    id: number;
    phone: string;
    firstName: string | null;
    lastName: string | null;
  };
  remaining?: number;
}

/** Saved campaign configuration prevents dialing; the message is admin-readable. */
export class CampaignConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignConfigError";
  }
}

/** Twilio errors that won't succeed on retry without user action (verify number, fix format, etc.) */
function isPermanentDialError(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  return code === 21219 || code === 21211 || code === 21214 || code === 21608 || code === 13224;
}

function afterUnsuccessfulAttempt(
  campaign: Pick<Campaign, "maxRetries" | "retryIntervalMinutes">,
  attempts: number,
  now: Date,
  permanent = false,
): { status: "failed" } | { status: "retrying"; nextAttemptAt: Date } {
  if (permanent || attempts >= 1 + campaign.maxRetries) return { status: "failed" };
  return { status: "retrying", nextAttemptAt: new Date(now.getTime() + campaign.retryIntervalMinutes * 60_000) };
}

function maxConcurrent(campaign: Pick<Campaign, "dialParallel" | "maxConcurrentCalls">): number {
  return campaign.dialParallel ? Math.max(1, campaign.maxConcurrentCalls || 1) : 1;
}

export interface CampaignClaim {
  linkId: number;
  campaignId: number;
  userId: number;
  claimToken: string;
  attempts: number;
  previous: Pick<CampaignContact, "status" | "attempts" | "nextAttemptAt" | "lastAttemptAt">;
  contact: { id: number; phone: string; firstName: string | null; lastName: string | null };
}

export type ClaimResult =
  | { kind: "claimed"; claim: CampaignClaim; campaign: Campaign; remaining: number }
  | { kind: "not_found" }
  | { kind: "not_active" }
  | { kind: "window_closed"; opensAt: Date }
  | { kind: "window_invalid"; reason: string }
  | { kind: "slots_full"; inFlight: number }
  | { kind: "none_ready" };

/**
 * Atomically claims the next eligible contact. A per-campaign transaction-scoped
 * advisory lock serializes claimers so the concurrency limit is not exceeded;
 * the conditional update on (status, attempts) is the single-winner guard even
 * without the lock. No network call happens inside the transaction.
 */
export async function claimNextCampaignContact(
  campaignId: number,
  userId: number,
  now = new Date(),
  connection: Connection = db,
): Promise<ClaimResult> {
  return connection.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK_NAMESPACE}, ${campaignId})`);
    const campaign = await tx.query.campaignsTable.findFirst({
      where: and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)),
    });
    if (!campaign) return { kind: "not_found" } as const;
    if (campaign.status !== "active") return { kind: "not_active" } as const;

    const window = evaluateCallingWindow(campaign, now);
    if (window.status === "invalid") return { kind: "window_invalid", reason: window.reason } as const;
    if (window.status === "closed") return { kind: "window_closed", opensAt: window.opensAt } as const;

    const links = await tx.select().from(campaignContactsTable).where(and(
      eq(campaignContactsTable.campaignId, campaign.id),
      inArray(campaignContactsTable.status, [...IN_FLIGHT_STATUSES, ...DIALABLE_STATUSES]),
    ));
    const inFlight = links.filter((link) => IN_FLIGHT.has(link.status));
    const logIds = inFlight.map((link) => link.callLogId).filter((id): id is number => id != null);
    const endedLogs = logIds.length
      ? await tx.select().from(callLogsTable).where(inArray(callLogsTable.id, logIds))
      : [];
    const ended = new Set(endedLogs.filter((log) => log.endedAt).map((log) => log.id));
    const occupying = inFlight.filter((link) => link.callLogId == null || !ended.has(link.callLogId));
    if (occupying.length >= maxConcurrent(campaign)) {
      return { kind: "slots_full", inFlight: occupying.length } as const;
    }

    // Duplicate links to the same contact never dial in parallel.
    const busyContacts = new Set(inFlight.map((link) => link.contactId));
    const ready = links
      .filter((link) =>
        (link.status === "pending" || link.status === "retrying") &&
        link.attempts < 1 + campaign.maxRetries &&
        (link.status === "pending" || (link.nextAttemptAt != null && link.nextAttemptAt <= now)) &&
        !busyContacts.has(link.contactId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
    if (!ready.length) return { kind: "none_ready" } as const;

    const scan = ready.slice(0, CLAIM_SCAN_LIMIT);
    const owned = await tx.select().from(contactsTable).where(and(
      eq(contactsTable.userId, campaign.userId),
      inArray(contactsTable.id, [...new Set(scan.map((link) => link.contactId))]),
    ));
    const contacts = new Map(owned.map((contact) => [contact.id, contact]));

    for (const link of scan) {
      const contact = contacts.get(link.contactId);
      if (!contact) {
        await tx.update(campaignContactsTable)
          .set({ status: "invalid_contact" })
          .where(and(eq(campaignContactsTable.id, link.id), eq(campaignContactsTable.status, link.status)));
        logger.warn({ campaignId: campaign.id, linkId: link.id }, "Campaign link skipped: contact not owned by campaign tenant");
        continue;
      }
      if (busyContacts.has(contact.id)) continue;
      const claimToken = randomUUID();
      const [claimed] = await tx.update(campaignContactsTable)
        .set({
          status: "dialing",
          claimToken,
          claimedAt: now,
          callLogId: null,
          attempts: link.attempts + 1,
          lastAttemptAt: now,
        })
        .where(and(
          eq(campaignContactsTable.id, link.id),
          eq(campaignContactsTable.status, link.status),
          eq(campaignContactsTable.attempts, link.attempts),
        ))
        .returning();
      if (!claimed) continue;
      return {
        kind: "claimed",
        campaign,
        remaining: ready.length - 1,
        claim: {
          linkId: link.id,
          campaignId: campaign.id,
          userId: campaign.userId,
          claimToken,
          attempts: claimed.attempts,
          previous: {
            status: link.status,
            attempts: link.attempts,
            nextAttemptAt: link.nextAttemptAt,
            lastAttemptAt: link.lastAttemptAt,
          },
          contact: { id: contact.id, phone: contact.phone, firstName: contact.firstName, lastName: contact.lastName },
        },
      } as const;
    }
    return { kind: "none_ready" } as const;
  });
}

function claimed(claim: CampaignClaim, statuses: readonly string[] = ["dialing"]) {
  return and(
    eq(campaignContactsTable.id, claim.linkId),
    eq(campaignContactsTable.claimToken, claim.claimToken),
    inArray(campaignContactsTable.status, [...statuses]),
  );
}

/** Undo a claim that never reached the provider; the attempt is not counted. */
export async function releaseClaim(claim: CampaignClaim, connection: Connection = db): Promise<boolean> {
  const released = await connection.update(campaignContactsTable)
    .set({
      status: claim.previous.status,
      attempts: claim.previous.attempts,
      nextAttemptAt: claim.previous.nextAttemptAt,
      lastAttemptAt: claim.previous.lastAttemptAt,
      claimToken: null,
      claimedAt: null,
      callLogId: null,
    })
    .where(claimed(claim))
    .returning();
  return released.length === 1;
}

class ClaimLostError extends Error {
  constructor() {
    super("Campaign contact claim no longer held");
    this.name = "ClaimLostError";
  }
}

/** Binds the call log to the claim before the provider request is sent. */
export async function bindClaimCallLog(claim: CampaignClaim, callLogId: number, connection: Connection = db): Promise<void> {
  const bound = await connection.update(campaignContactsTable)
    .set({ callLogId })
    .where(claimed(claim))
    .returning();
  if (bound.length !== 1) throw new ClaimLostError();
}

type DispatchOutcome =
  | { kind: "dispatched"; callLogId: number; providerCallId: string }
  | { kind: "released"; reason: "not_active" | "window_closed" | "window_invalid" | "claim_lost" | "budget"; opensAt?: Date; detail?: string }
  | { kind: "blocked"; code: DialBlockedError["code"]; message: string }
  | { kind: "rejected"; message: string; callLogId: number }
  | { kind: "unknown"; message: string; callLogId: number };

/**
 * Dispatches a claimed contact. Campaign state and the calling window are
 * re-checked immediately before the provider request; the opt-out check runs
 * inside placeOutboundCall. Nothing here holds a transaction.
 */
export async function dispatchClaim(
  claim: CampaignClaim,
  baseUrl: string,
  connection: Connection = db,
): Promise<DispatchOutcome> {
  const campaign = await connection.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, claim.campaignId), eq(campaignsTable.userId, claim.userId)),
  });
  if (!campaign || campaign.status !== "active") {
    await releaseClaim(claim, connection);
    return { kind: "released", reason: "not_active" };
  }
  const window = evaluateCallingWindow(campaign, new Date());
  if (window.status !== "open") {
    await releaseClaim(claim, connection);
    return window.status === "closed"
      ? { kind: "released", reason: "window_closed", opensAt: window.opensAt }
      : { kind: "released", reason: "window_invalid", detail: window.reason };
  }

  const agentConfig = await connection.query.agentConfigsTable.findFirst({
    where: eq(agentConfigsTable.userId, claim.userId),
  });
  const crmMetadata = await buildCallCrmMetadataForCampaign(campaign, claim.userId);
  let boundLogId: number | null = null;

  try {
    const placed = await placeOutboundCall({
      userId: claim.userId,
      contactId: claim.contact.id,
      campaignId: campaign.id,
      phone: claim.contact.phone,
      aiModel: agentConfig?.aiModel || "gpt-4o-mini",
      baseUrl,
      crmMetadata: crmMetadata ?? null,
      budgetKey: `campaign:${claim.claimToken}`,
      onCallLogCreated: async (callLogId) => {
        await bindClaimCallLog(claim, callLogId, connection);
        boundLogId = callLogId;
      },
    });

    // A fast terminal callback may already have advanced the link; it wins.
    await connection.update(campaignContactsTable)
      .set({ status: "calling" })
      .where(claimed(claim));
    await connection.update(campaignsTable)
      .set({ calledCount: sql`${campaignsTable.calledCount} + 1`, updatedAt: new Date() })
      .where(and(eq(campaignsTable.id, campaign.id), eq(campaignsTable.userId, claim.userId)));
    await connection.update(contactsTable)
      .set({ status: "called", lastCalledAt: new Date(), updatedAt: new Date() })
      .where(and(eq(contactsTable.id, claim.contact.id), eq(contactsTable.userId, claim.userId)));
    return { kind: "dispatched", callLogId: placed.callLogId, providerCallId: placed.providerCallId };
  } catch (err) {
    if (err instanceof DialBlockedError) {
      if (err.code === "suppression_unavailable") {
        await releaseClaim(claim, connection);
      } else {
        await connection.update(campaignContactsTable)
          .set({
            status: err.code === "suppressed" ? "suppressed" : "failed",
            attempts: claim.previous.attempts,
            claimToken: null,
          })
          .where(claimed(claim));
      }
      logger.warn({ campaignId: campaign.id, linkId: claim.linkId, reason: err.code }, "Campaign dial blocked before dispatch");
      return { kind: "blocked", code: err.code, message: err.message };
    }
    if (err instanceof ClaimLostError) return { kind: "released", reason: "claim_lost" };
    if (err instanceof SpendLimitError) {
      // Refused before any call log or provider request: the attempt is not counted.
      await releaseClaim(claim, connection);
      logger.warn({ campaignId: campaign.id, reason: err.code }, "Campaign dial held by spend limit");
      return { kind: "released", reason: "budget", detail: err.message };
    }
    if (boundLogId === null) {
      // Failed before any call log or provider request (e.g. telephony not configured).
      await releaseClaim(claim, connection);
      throw err;
    }

    const callLogId: number = boundLogId;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ProviderDispatchError && err.definite) {
      await claimCallFinalization(callLogId, {
        outcome: "no_answer",
        endedAt: new Date(),
        transcript: "Failed to dial: provider rejected the request.",
      }, connection);
      const next = afterUnsuccessfulAttempt(campaign, claim.attempts, new Date(), isPermanentDialError(err));
      await connection.update(campaignContactsTable)
        .set({ ...next, claimToken: null })
        .where(claimed(claim));
      logger.warn(
        { campaignId: campaign.id, linkId: claim.linkId, callLogId, providerCode: err.code },
        "Campaign dial rejected by provider",
      );
      return { kind: "rejected", message, callLogId };
    }

    // Timeout, network error or 5xx: the provider may have created the call.
    // Never redial blindly; reconciliation resolves it from callbacks or age.
    await connection.update(campaignContactsTable)
      .set({ status: "dispatch_unknown" })
      .where(claimed(claim));
    logger.error(
      { campaignId: campaign.id, linkId: claim.linkId, callLogId, err: err instanceof Error ? err.name : "Error" },
      "Campaign dial outcome unknown; held for reconciliation",
    );
    return { kind: "unknown", message, callLogId };
  }
}

/**
 * Applies a finalized call's outcome to its campaign link. The link is found
 * by call log id within the call's own tenant and only advances from an
 * in-flight state, so duplicate or late finalizations cannot double count.
 */
export async function applyCampaignCallOutcome(
  callLog: { id: number; userId: number; campaignId: number | null },
  outcome: string,
  now = new Date(),
  connection: Connection = db,
): Promise<boolean> {
  if (!callLog.campaignId) return false;
  const link = await connection.query.campaignContactsTable.findFirst({
    where: and(
      eq(campaignContactsTable.callLogId, callLog.id),
      eq(campaignContactsTable.campaignId, callLog.campaignId),
    ),
  });
  if (!link || !IN_FLIGHT.has(link.status)) return false;
  const campaign = await connection.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, link.campaignId), eq(campaignsTable.userId, callLog.userId)),
  });
  if (!campaign) return false;

  const next = outcome === "answered" ? { status: "answered" as const } : afterUnsuccessfulAttempt(campaign, link.attempts, now);
  const advanced = await connection.update(campaignContactsTable)
    .set({ ...next, claimToken: null })
    .where(and(
      eq(campaignContactsTable.id, link.id),
      eq(campaignContactsTable.callLogId, callLog.id),
      inArray(campaignContactsTable.status, [...IN_FLIGHT_STATUSES]),
    ))
    .returning();
  if (advanced.length !== 1) return false;
  if (outcome === "answered") {
    await connection.update(campaignsTable)
      .set({ answeredCount: sql`${campaignsTable.answeredCount} + 1` })
      .where(eq(campaignsTable.id, campaign.id));
  }
  return true;
}

/**
 * Resolves in-flight links whose worker or callback was lost. Stale claims
 * without a call log are released (nothing was sent); links whose call ended
 * take its outcome; dispatches that never got a provider id, and calls that
 * never got a terminal callback, are finalized as no_answer after a horizon
 * via the shared finalization claim.
 */
export async function reconcileCampaignDispatches(
  campaignId: number,
  now = new Date(),
  connection: Connection = db,
): Promise<void> {
  const campaign = await connection.query.campaignsTable.findFirst({ where: eq(campaignsTable.id, campaignId) });
  if (!campaign) return;
  const links = await connection.select().from(campaignContactsTable).where(and(
    eq(campaignContactsTable.campaignId, campaignId),
    inArray(campaignContactsTable.status, [...IN_FLIGHT_STATUSES]),
  ));

  for (const link of links) {
    const age = now.getTime() - (link.claimedAt ?? link.lastAttemptAt ?? link.createdAt).getTime();
    const log = link.callLogId != null
      ? await connection.query.callLogsTable.findFirst({ where: eq(callLogsTable.id, link.callLogId) })
      : undefined;

    if (!log) {
      const stale = link.status === "dialing" ? age > STALE_CLAIM_MS : age > DISPATCH_UNKNOWN_MS;
      if (!stale) continue;
      const guard = and(
        eq(campaignContactsTable.id, link.id),
        eq(campaignContactsTable.status, link.status),
        eq(campaignContactsTable.attempts, link.attempts),
      );
      if (link.status === "dialing" && link.callLogId == null) {
        // Nothing reached the provider: undo the claim. Claims never change
        // nextAttemptAt, so the pre-claim schedule is still in place.
        const attempts = Math.max(0, link.attempts - 1);
        await connection.update(campaignContactsTable)
          .set({ status: attempts === 0 ? "pending" : "retrying", attempts, claimToken: null, claimedAt: null })
          .where(guard);
      } else {
        await connection.update(campaignContactsTable)
          .set({ ...afterUnsuccessfulAttempt(campaign, link.attempts, now), claimToken: null })
          .where(guard);
      }
      continue;
    }

    if (log.userId !== campaign.userId) continue;
    if (log.finalizedAt || (log.endedAt && now.getTime() - log.endedAt.getTime() > ENDED_GRACE_MS)) {
      await applyCampaignCallOutcome(log, log.outcome === "answered" ? "answered" : "no_answer", now, connection);
      continue;
    }
    if (log.endedAt) continue;
    const noProviderId = !log.callSid && age > DISPATCH_UNKNOWN_MS;
    if (noProviderId || age > MAX_ACTIVE_CALL_MS) {
      const won = await claimCallFinalization(log.id, {
        outcome: "no_answer",
        endedAt: now,
        ...(noProviderId ? { transcript: "Dial outcome unknown; closed by reconciliation." } : {}),
      }, connection);
      if (won) {
        // Whether the provider billed this call is not known: the telephony
        // entry stays in reconciliation (a no-op if dispatch already recorded it).
        const provider = await outboundTelephonyProvider(log.userId, connection);
        const provisionalAmount = await telephonyHold(provider, "outbound", await callHoldMinutes(log.userId, connection), connection);
        await recordCallTelephony(log, { provider, seconds: null, measurement: "unknown", provisionalAmount, reason: noProviderId ? "dispatch_unknown" : "no_terminal_callback" }, connection)
          .catch((err) => logger.error({ err, callLogId: log.id }, "Reconciliation usage recording failed"));
        await settleCall(log.id, "reconciled", connection)
          .catch((err) => logger.error({ err, callLogId: log.id }, "Reconciliation budget release failed"));
        await applyCampaignCallOutcome(log, "no_answer", now, connection);
        logger.warn({ campaignId, linkId: link.id, callLogId: log.id }, "Campaign dispatch reconciled as no_answer");
      }
    }
  }
}

/** Mark campaign completed when every contact is done and no calls are in progress. */
export async function tryMarkCampaignCompleted(campaignId: number, connection: Connection = db): Promise<boolean> {
  const campaign = await connection.query.campaignsTable.findFirst({
    where: eq(campaignsTable.id, campaignId),
  });
  if (!campaign || campaign.status !== "active") return false;

  await reconcileCampaignDispatches(campaignId, new Date(), connection);

  const links = await connection
    .select()
    .from(campaignContactsTable)
    .where(eq(campaignContactsTable.campaignId, campaignId));

  if (links.length === 0) return false;
  if (links.some((link) => IN_FLIGHT.has(link.status))) return false;

  const now = new Date();
  const allTerminal = links.every((link) =>
    TERMINAL_STATUSES.has(link.status) || link.attempts >= 1 + campaign.maxRetries);

  const allDialedOnce =
    links.every((link) => link.attempts >= 1 || TERMINAL_STATUSES.has(link.status)) &&
    links.every((link) => link.status !== "pending") &&
    (campaign.calledCount || 0) >= links.filter((link) => link.attempts >= 1).length;

  const retryWaiting = links.some(
    (link) =>
      link.status === "retrying" &&
      link.attempts < 1 + campaign.maxRetries &&
      link.nextAttemptAt &&
      link.nextAttemptAt > now,
  );

  const shouldComplete = allTerminal || (allDialedOnce && !retryWaiting);

  if (!shouldComplete) return false;

  const completed = await connection
    .update(campaignsTable)
    .set({ status: "completed", updatedAt: new Date() })
    .where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.status, "active")))
    .returning();
  if (completed.length !== 1) return false;

  logger.info({ campaignId, allTerminal, allDialedOnce }, "Campaign marked as completed");
  return true;
}

export async function dialNextForCampaign(
  campaignId: number,
  userId: number,
  baseUrl: string
): Promise<DialNextResult> {
  await reconcileCampaignDispatches(campaignId);
  const result = await claimNextCampaignContact(campaignId, userId);

  switch (result.kind) {
    case "not_found":
      throw new Error("Campaign not found");
    case "not_active":
      throw new Error("Campaign is not active");
    case "window_invalid":
      throw new CampaignConfigError(`Calling window is not configured correctly: ${result.reason}`);
    case "window_closed":
      return {
        done: true,
        deferred: true,
        nextWindowAt: result.opensAt.toISOString(),
        message: "Outside the campaign's calling window. Contacts stay queued until it reopens.",
      };
    case "slots_full":
      return { done: true, waiting: true, message: "All concurrent call slots for this campaign are busy." };
    case "none_ready": {
      const completed = await tryMarkCampaignCompleted(campaignId);
      if (completed) {
        return { done: true, message: "All contacts have been called. Campaign marked as completed." };
      }
      const campaign = await db.query.campaignsTable.findFirst({
        where: and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)),
      });
      const links = await db.select().from(campaignContactsTable)
        .where(eq(campaignContactsTable.campaignId, campaignId));
      const maxAttempts = 1 + (campaign?.maxRetries ?? 0);
      const remainingCount = links.filter((link) =>
        !TERMINAL_STATUSES.has(link.status) && link.attempts < maxAttempts).length;
      if (remainingCount === 0 && !links.some((link) => IN_FLIGHT.has(link.status))) {
        await db.update(campaignsTable)
          .set({ status: "completed", updatedAt: new Date() })
          .where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId), eq(campaignsTable.status, "active")));
        return { done: true, message: "All contacts have been called and retries exhausted. Campaign marked as completed." };
      }
      return { done: true, message: `No contacts available to dial right now. ${remainingCount} contacts scheduled for future retries.` };
    }
  }

  const { claim } = result;
  const outcome = await dispatchClaim(claim, baseUrl);
  switch (outcome.kind) {
    case "dispatched":
      return {
        done: false,
        callSid: outcome.providerCallId,
        callLogId: outcome.callLogId,
        contact: claim.contact,
        remaining: result.remaining,
      };
    case "released":
      if (outcome.reason === "window_invalid") {
        throw new CampaignConfigError(`Calling window is not configured correctly: ${outcome.detail}`);
      }
      if (outcome.reason === "not_active") throw new Error("Campaign is not active");
      if (outcome.reason === "budget") {
        return { done: true, budgetBlocked: true, error: outcome.detail, message: outcome.detail };
      }
      return outcome.reason === "window_closed"
        ? {
            done: true,
            deferred: true,
            nextWindowAt: outcome.opensAt?.toISOString(),
            message: "Outside the campaign's calling window. Contacts stay queued until it reopens.",
          }
        : { done: true, waiting: true, message: "Another dialer took this contact." };
    case "blocked":
      if (outcome.code === "suppression_unavailable") {
        return { done: true, dialFailed: true, error: outcome.message, message: outcome.message };
      }
      return { done: false, dialFailed: true, error: outcome.message, contact: claim.contact, remaining: result.remaining };
    case "rejected":
    case "unknown":
      return {
        done: false,
        dialFailed: true,
        error: outcome.message,
        callLogId: outcome.callLogId,
        contact: claim.contact,
        remaining: result.remaining,
      };
  }
}

const reportedConfigProblems = new Map<number, string>();

export async function triggerDialingForCampaign(
  campaignId: number,
  userId: number,
  baseUrl: string
): Promise<void> {
  const campaign = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)),
  });

  if (!campaign || campaign.status !== "active" || !campaign.isAutomatic) {
    return;
  }

  let safety = 0;

  // Fill parallel slots; failed dials return dialFailed and we immediately try the next contact.
  // Slot accounting and contact claiming happen atomically in claimNextCampaignContact.
  while (safety++ < 50) {
    try {
      const result = await dialNextForCampaign(campaignId, userId, baseUrl);

      if (result.done) {
        break;
      }

      if (result.dialFailed) {
        continue;
      }

      // Sequential auto-dial: stop after placing one successful call
      if (!campaign.dialParallel) {
        break;
      }
    } catch (err) {
      if (err instanceof CampaignConfigError) {
        if (reportedConfigProblems.get(campaignId) !== err.message) {
          reportedConfigProblems.set(campaignId, err.message);
          logger.error({ campaignId, problem: err.message }, "Campaign not dialing: invalid calling window");
        }
      } else if (err instanceof TelephonyNotConfiguredError) {
        logger.error({ campaignId }, "Campaign dial aborted — telephony not configured");
      } else {
        logger.error({ err, campaignId }, "Campaign dial aborted — configuration error");
      }
      break;
    }
  }

  await tryMarkCampaignCompleted(campaignId);
}

/** Periodically fill parallel slots and pick up retry-ready contacts for active campaigns. */
export function startCampaignDialScheduler(): void {
  const intervalMs = 15_000;

  setInterval(async () => {
    try {
      const activeCampaigns = await db.select().from(campaignsTable).where(
        and(
          eq(campaignsTable.status, "active"),
          eq(campaignsTable.isAutomatic, true),
        ),
      );

      if (activeCampaigns.length === 0) return;

      const baseUrl = getCampaignBaseUrl();

      for (const campaign of activeCampaigns) {
        await triggerDialingForCampaign(campaign.id, campaign.userId, baseUrl);
      }
    } catch (err) {
      logger.error({ err }, "[campaign-dial-scheduler] Error");
    }
  }, intervalMs);

  logger.info("Campaign dial scheduler started (15s interval)");
}
