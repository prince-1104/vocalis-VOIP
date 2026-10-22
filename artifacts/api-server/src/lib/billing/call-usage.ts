import { db, tenantsTable, budgetReservationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { logger } from "../logger";
import { aiWorkHold, callHoldMinutes, telephonyHold, type AiWorkEstimate } from "./estimates";
import { billedCallMinutes } from "./rate-card";
import {
  reserveBudget,
  releaseCallReservations,
  releaseReservation,
  topUpReservation,
  type Reservation,
} from "./spend-budget";
import { recordUsage, syncCallLogCosts, type UsageOutcome } from "./usage-ledger";
import type { UsageMeasurement } from "@workspace/db";

import type { Connection } from "./connection";

/** Longest a call hold can outlive a lost finalization (6 h active-call horizon + margin). */
export const CALL_HOLD_TTL_MS = 6 * 60 * 60_000 + 15 * 60_000;

export type CallLeg = "outbound" | "inbound" | "client";

export function telephonyLeg(direction: string | null | undefined): CallLeg {
  if (direction === "inbound") return "inbound";
  if (direction === "widget-voice") return "client";
  return "outbound";
}

/** Usage provider for a tenant's outbound route (SIP trunks are not priced as PSTN). */
export async function outboundTelephonyProvider(userId: number, connection: Connection = db): Promise<string> {
  const tenant = await connection.query.tenantsTable.findFirst({ where: eq(tenantsTable.ownerId, userId) });
  if (tenant?.telephonyType === "EXOTEL") return "exotel";
  if (tenant?.telephonyType === "SIP_TRUNK") return "twilio-sip";
  return "twilio";
}

export function usageProviderForDispatch(provider: "TWILIO" | "SIP_TRUNK" | "EXOTEL"): string {
  return provider === "EXOTEL" ? "exotel" : provider === "SIP_TRUNK" ? "twilio-sip" : "twilio";
}

/** Holds the expected telephony cost of a call before the provider is asked to connect it. */
export async function reserveCallBudget(params: {
  userId: number;
  provider: string;
  leg: CallLeg;
  source: string;
  key?: string;
  callLogId?: number | null;
}, connection: Connection = db): Promise<Reservation> {
  const minutes = await callHoldMinutes(params.userId, connection);
  const amount = await telephonyHold(params.provider, params.leg, minutes, connection);
  return reserveBudget({
    userId: params.userId,
    key: params.key ?? `call-hold:${randomUUID()}`,
    amount,
    source: params.source,
    ttlMs: CALL_HOLD_TTL_MS,
    callLogId: params.callLogId ?? null,
  }, connection);
}

export const callTelephonyKey = (callLogId: number) => `telephony:call:${callLogId}`;

export interface CallTelephonyEvidence {
  provider: string;
  /** Billed duration in seconds; null when unknown. */
  seconds: number | null;
  measurement: UsageMeasurement;
  outcome?: UsageOutcome;
  provisionalAmount?: number;
  providerCost?: { amount: number; currency: string } | null;
  providerRequestId?: string | null;
  reason?: string;
}

/**
 * Records the call's own telephony leg once per call; later, stronger evidence
 * (a signed provider callback after a media-close estimate) reconciles it.
 */
export async function recordCallTelephony(
  callLog: { id: number; userId: number; direction: string | null; startedAt: Date | null; callSid?: string | null },
  evidence: CallTelephonyEvidence,
  connection: Connection = db,
) {
  const leg = telephonyLeg(callLog.direction);
  return recordUsage({
    userId: callLog.userId,
    callLogId: callLog.id,
    source: "call",
    category: "telephony",
    provider: evidence.provider,
    model: `voice-${leg}`,
    leg,
    providerRequestId: evidence.providerRequestId ?? callLog.callSid ?? null,
    idempotencyKey: callTelephonyKey(callLog.id),
    measurement: evidence.measurement,
    unit: "call_seconds",
    quantity: evidence.seconds,
    outcome: evidence.outcome,
    provisionalAmount: evidence.provisionalAmount,
    providerCost: evidence.providerCost,
    eventAt: callLog.startedAt ?? new Date(),
    metadata: evidence.reason ? { reason: evidence.reason } : undefined,
  }, connection);
}

/** A turn's hold outlives any single provider request it covers. */
const TURN_HOLD_TTL_MS = 10 * 60_000;
const turnKeyPrefix = (callLogId: number) => `turn:${callLogId}:`;

/** Holds the expected AI cost of one conversational turn before any provider request. */
export async function reserveTurnBudget(params: {
  userId: number;
  callLogId: number;
  turnId: string;
  estimate: AiWorkEstimate;
}, connection: Connection = db): Promise<Reservation> {
  return reserveBudget({
    userId: params.userId,
    key: `${turnKeyPrefix(params.callLogId)}${params.turnId}`,
    amount: await aiWorkHold(params.estimate, connection),
    source: "call-turn",
    ttlMs: TURN_HOLD_TTL_MS,
    callLogId: params.callLogId,
  }, connection);
}

export async function releaseTurnBudget(hold: Reservation, reason = "turn_complete", connection: Connection = db): Promise<void> {
  await releaseReservation(hold.tenantId, hold.key, reason, connection)
    .catch((err) => logger.error({ err }, "Turn budget release failed"));
}

/** Telephony minutes kept on hold beyond those already elapsed. */
export const CALL_HOLD_MARGIN_MINUTES = 5;

/**
 * Keeps the call's telephony hold ahead of its elapsed duration. Throws
 * SpendLimitError when a hard limit refuses the extension (the caller ends the
 * call gracefully). Calls without a hold (e.g. started before this ledger) are left alone.
 */
export async function extendCallHold(
  call: { id: number; userId: number; direction: string | null },
  elapsedSeconds: number,
  connection: Connection = db,
): Promise<void> {
  const held = await connection.select().from(budgetReservationsTable).where(and(
    eq(budgetReservationsTable.callLogId, call.id),
    eq(budgetReservationsTable.status, "held"),
  ));
  const hold = held.find((row) => !row.idempotencyKey.startsWith(turnKeyPrefix(call.id)));
  if (!hold) return;
  const leg = telephonyLeg(call.direction);
  const provider = leg === "outbound" ? await outboundTelephonyProvider(call.userId, connection) : "twilio";
  const target = await telephonyHold(provider, leg, billedCallMinutes(elapsedSeconds) + CALL_HOLD_MARGIN_MINUTES, connection);
  if (target <= Number(hold.amount)) return;
  await topUpReservation(hold.tenantId, hold.idempotencyKey, target, connection);
}

/** Releases the call's holds after its usage is in the ledger, then mirrors costs onto the call log. */
export async function settleCall(callLogId: number, reason: string, connection: Connection = db) {
  await releaseCallReservations(callLogId, reason, connection);
  return syncCallLogCosts(callLogId, connection);
}
