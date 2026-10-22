import twilio from "twilio";
import { bindTwilioCallSid, mediaPublicUrl } from "../media-session";
import { db, callLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { exotelConnectToFlow } from "./exotel-client";
import { resolveTelephonyForUser, TelephonyNotConfiguredError } from "./resolve-telephony";
import { fetchExternalCrmData, getExternalCrmCallFlow } from "../external-crm-lookup";
import { callMetaCache } from "../../routes/twilio";
import { assertDialAllowed, DialBlockedError } from "../call-suppression";
import { recordCallTelephony, reserveCallBudget, usageProviderForDispatch } from "../billing/call-usage";
import { bindReservationCall, releaseReservation, SpendLimitError } from "../billing/spend-budget";
import { logger } from "../logger";

export interface PlaceOutboundCallParams {
  userId: number;
  contactId?: number | null;
  campaignId?: number | null;
  phone: string;
  aiModel?: string;
  baseUrl: string;
  crmContactId?: string | null;
  crmMetadata?: Record<string, unknown> | null;
  /**
   * Runs after the call log exists and before the provider request; throwing
   * aborts the dial. Campaigns use it to bind the attempt to its claim.
   */
  onCallLogCreated?: (callLogId: number) => Promise<void>;
  /** Idempotency key for the budget hold (campaign claims pass their claim token). */
  budgetKey?: string;
}

/**
 * Provider request failure. `definite` means the provider rejected the request
 * (HTTP 4xx), so no call was created; otherwise the outcome is unknown.
 */
export class ProviderDispatchError extends Error {
  constructor(readonly cause: unknown, readonly definite: boolean, readonly code?: number) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ProviderDispatchError";
  }
}

function dispatchError(err: unknown): ProviderDispatchError {
  const status = (err as { status?: unknown })?.status;
  const code = (err as { code?: unknown })?.code;
  // Timeouts, network errors, 5xx and missing call IDs leave the outcome unknown.
  const definite = typeof status === "number" && status >= 400 && status < 500 && status !== 408;
  return new ProviderDispatchError(err, definite, typeof code === "number" ? code : undefined);
}

export interface PlaceOutboundCallResult {
  callLogId: number;
  providerCallId: string;
  provider: "TWILIO" | "SIP_TRUNK" | "EXOTEL";
}

function getTwilioClient(accountSid: string, authToken: string) {
  return twilio(accountSid, authToken);
}

/**
 * Unified outbound dial — routes to Exotel or Twilio based on tenant telephonyType.
 * Every outbound call to a customer passes the tenant's do-not-call check and
 * spend-limit hold here, immediately before the call log and provider request.
 */
export async function placeOutboundCall(params: PlaceOutboundCallParams): Promise<PlaceOutboundCallResult> {
  const { userId, phone, baseUrl } = params;
  await assertDialAllowed(userId, phone);
  const telephony = await resolveTelephonyForUser(userId, phone);
  const usageProvider = usageProviderForDispatch(telephony.provider);
  const hold = await reserveCallBudget({
    userId,
    provider: usageProvider,
    leg: "outbound",
    source: params.campaignId ? "campaign" : "dial",
    key: params.budgetKey,
  });
  const releaseHold = (reason: string) =>
    releaseReservation(hold.tenantId, hold.key, reason).catch((err) => {
      logger.error({ err }, "Budget hold release failed");
      return false;
    });

  let callLog: typeof callLogsTable.$inferSelect;
  try {
    [callLog] = await db.insert(callLogsTable).values({
      userId,
      contactId: params.contactId ?? null,
      campaignId: params.campaignId ?? null,
      direction: "outbound",
      phone,
      outcome: "no_answer",
      aiModel: params.aiModel || "gpt-4o-mini",
      startedAt: new Date(),
      crmContactId: params.crmContactId ?? null,
      crmMetadata: params.crmMetadata ?? null,
    }).returning();
    await bindReservationCall(hold.tenantId, hold.key, callLog.id);
  } catch (err) {
    await releaseHold("call_not_created");
    throw err;
  }

  if (params.onCallLogCreated) {
    try {
      await params.onCallLogCreated(callLog.id);
    } catch (err) {
      await releaseHold("call_not_placed");
      await db.update(callLogsTable)
        .set({ endedAt: new Date(), outcome: "no_answer", transcript: "Call not placed." })
        .where(eq(callLogsTable.id, callLog.id));
      throw err;
    }
  }

  // A definite rejection created no call. An unknown outcome may still be
  // billed: the ledger keeps it in reconciliation with the hold as provisional
  // spend until a provider callback or an operator supplies the duration.
  const dispatchFailed = async (err: unknown): Promise<never> => {
    const failure = dispatchError(err);
    await recordCallTelephony(callLog, failure.definite
      ? { provider: usageProvider, seconds: 0, measurement: "actual", outcome: "not_charged", reason: "dispatch_rejected" }
      : { provider: usageProvider, seconds: null, measurement: "unknown", provisionalAmount: hold.amount, reason: "dispatch_unknown" },
    ).catch((recordErr) => logger.error({ err: recordErr, callLogId: callLog.id }, "Dispatch usage recording failed"));
    await releaseHold(failure.definite ? "dispatch_rejected" : "dispatch_unknown");
    throw failure;
  };

  // Fire-and-forget: pre-fetch external CRM data so it's available when the media stream connects
  fetchExternalCrmData(userId, phone).then(crmCtx => {
    if (!crmCtx) return;
    const key = String(callLog.id);
    const meta = callMetaCache.get(key);
    if (meta) {
      meta.externalCrmContext = crmCtx;
    }
  }).catch(() => {});

  getExternalCrmCallFlow(userId).then(flow => {
    if (!flow) return;
    const key = String(callLog.id);
    const meta = callMetaCache.get(key);
    if (meta) meta.externalCrmCallFlow = flow;
  }).catch(() => {});

  if (telephony.provider === "EXOTEL") {
    const statusCallback = `${baseUrl}/api/exotel/status?callLogId=${callLog.id}`;
    const result = await exotelConnectToFlow({
      credentials: telephony.credentials,
      customerPhone: telephony.customerPhone,
      statusCallbackUrl: statusCallback,
      customField: String(callLog.id),
      timeOutSec: 45,
    }).catch(dispatchFailed);

    await db.update(callLogsTable)
      .set({ callSid: result.callSid })
      .where(eq(callLogsTable.id, callLog.id));

    return {
      callLogId: callLog.id,
      providerCallId: result.callSid,
      provider: "EXOTEL",
    };
  }

  const client = getTwilioClient(telephony.twilioAccountSid, telephony.twilioAuthToken);
  const call = await client.calls.create({
    to: telephony.toPhone,
    from: telephony.fromPhone,
    url: mediaPublicUrl(`/api/twilio/outbound-voice?callLogId=${callLog.id}`),
    statusCallback: mediaPublicUrl(`/api/twilio/status?callLogId=${callLog.id}`),
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["completed", "no-answer", "busy", "failed", "canceled"],
    machineDetection: "Enable",
    asyncAmd: "true",
    ...(telephony.sipAuthUsername && telephony.sipAuthPassword
      ? { sipAuthUsername: telephony.sipAuthUsername, sipAuthPassword: telephony.sipAuthPassword }
      : {}),
  }).catch(dispatchFailed);

  await bindTwilioCallSid(callLog.id, call.sid);

  return {
    callLogId: callLog.id,
    providerCallId: call.sid,
    provider: telephony.provider,
  };
}

export { TelephonyNotConfiguredError, DialBlockedError, SpendLimitError };
