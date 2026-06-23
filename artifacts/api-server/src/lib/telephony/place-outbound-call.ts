import twilio from "twilio";
import { db, callLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { exotelConnectToFlow } from "./exotel-client";
import { resolveTelephonyForUser, TelephonyNotConfiguredError } from "./resolve-telephony";
import { fetchExternalCrmData } from "../external-crm-lookup";
import { callMetaCache } from "../../routes/twilio";

export interface PlaceOutboundCallParams {
  userId: number;
  contactId?: number | null;
  campaignId?: number | null;
  phone: string;
  aiModel?: string;
  baseUrl: string;
  crmContactId?: string | null;
  crmMetadata?: Record<string, unknown> | null;
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
 */
export async function placeOutboundCall(params: PlaceOutboundCallParams): Promise<PlaceOutboundCallResult> {
  const { userId, phone, baseUrl } = params;
  const telephony = await resolveTelephonyForUser(userId, phone);

  const [callLog] = await db.insert(callLogsTable).values({
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

  // Fire-and-forget: pre-fetch external CRM data so it's available when the media stream connects
  fetchExternalCrmData(userId, phone).then(crmCtx => {
    if (!crmCtx) return;
    const key = String(callLog.id);
    const meta = callMetaCache.get(key);
    if (meta) {
      meta.externalCrmContext = crmCtx;
    }
  }).catch(() => {});

  if (telephony.provider === "EXOTEL") {
    const statusCallback = `${baseUrl}/api/exotel/status?callLogId=${callLog.id}`;
    const result = await exotelConnectToFlow({
      credentials: telephony.credentials,
      customerPhone: telephony.customerPhone,
      statusCallbackUrl: statusCallback,
      customField: String(callLog.id),
      timeOutSec: 45,
    });

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
    url: `${baseUrl}/api/twilio/outbound-voice?callLogId=${callLog.id}&userId=${userId}`,
    statusCallback: `${baseUrl}/api/twilio/status?callLogId=${callLog.id}`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["completed", "no-answer", "busy", "failed", "canceled"],
    machineDetection: "Enable",
    asyncAmd: "true",
    ...(telephony.sipAuthUsername && telephony.sipAuthPassword
      ? { sipAuthUsername: telephony.sipAuthUsername, sipAuthPassword: telephony.sipAuthPassword }
      : {}),
  });

  await db.update(callLogsTable)
    .set({ callSid: call.sid })
    .where(eq(callLogsTable.id, callLog.id));

  return {
    callLogId: callLog.id,
    providerCallId: call.sid,
    provider: telephony.provider,
  };
}

export { TelephonyNotConfiguredError };
