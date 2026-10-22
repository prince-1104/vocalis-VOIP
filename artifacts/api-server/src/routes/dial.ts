import { Router, type IRouter } from "express";
import twilio from "twilio";
import { db, agentConfigsTable, callLogsTable, contactsTable, campaignsTable, campaignContactsTable, callingScriptsTable, tenantsTable, sipTrunkConfigsTable, crmAgentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { dialNextForCampaign } from "../lib/campaign-dialer";
import { placeOutboundCall, TelephonyNotConfiguredError } from "../lib/telephony/place-outbound-call";
import { DialBlockedError, dialBlockedHttpStatus } from "../lib/call-suppression";
import { SpendLimitError, spendLimitHttpStatus } from "../lib/billing/spend-budget";
import { outboundTelephonyProvider, recordCallTelephony, settleCall } from "../lib/billing/call-usage";
import { logger } from "../lib/logger";
import { resolveTelephonyForUser } from "../lib/telephony/resolve-telephony";
import { exotelHangupCall } from "../lib/telephony/exotel-client";
import { hasCrmIntegration, executeTransfer } from "../lib/transfer-manager";
import { callTransferRateLimit, dialRateLimit } from "../lib/rate-limit-policies";
import { twilioAuthTokenFor } from "../lib/tenant-credentials";

const router: IRouter = Router();

function getTwilioClient(accountSid: string, authToken: string) {
  return twilio(accountSid, authToken);
}

const TWILIO_TERMINAL_STATUSES = new Set([
  "completed", "busy", "failed", "no-answer", "canceled",
]);

const TWILIO_OUTCOME_MAP: Record<string, string> = {
  completed: "answered",
  "no-answer": "no_answer",
  busy: "busy",
  failed: "no_answer",
  canceled: "no_answer",
};

/** Map Twilio CallStatus to dialer UI states */
function mapTwilioCallStatus(
  twilioStatus: string,
  endedAt: Date | null,
  endTime?: Date | null,
  durationSecs?: number,
): string {
  if (endedAt || endTime) return "ended";
  if (TWILIO_TERMINAL_STATUSES.has(twilioStatus)) return "ended";
  // Completed with 0 duration = rejected / unanswered
  if (twilioStatus === "completed" && durationSecs === 0) return "ended";
  switch (twilioStatus) {
    case "queued":
    case "initiated":
      return "dialing";
    case "ringing":
      return "ringing";
    case "in-progress":
      return "active";
    default:
      return "dialing";
  }
}

async function syncCallEndFromTwilio(
  callId: number,
  twilioStatus: string,
  endTime: Date | null | undefined,
  durationSecs: number,
) {
  const outcome = TWILIO_OUTCOME_MAP[twilioStatus]
    ?? (durationSecs > 0 ? "answered" : "no_answer");

  await db.update(callLogsTable)
    .set({
      endedAt: endTime ?? new Date(),
      outcome,
      duration: durationSecs,
    })
    .where(eq(callLogsTable.id, callId));
}

function getBaseUrl(req: any): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    const first = domains.split(",")[0].trim();
    return `https://${first}`;
  }
  const host = req.headers.host || "localhost";
  return `https://${host}`;
}

/**
 * Resolves an optional campaign id from the request: null when absent,
 * undefined when malformed or not owned (callers answer a uniform 404).
 */
async function ownedCampaignId(userId: number, raw: unknown): Promise<number | null | undefined> {
  if (raw === undefined || raw === null || raw === "") return null;
  const id = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  const campaign = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId)),
  });
  return campaign ? campaign.id : undefined;
}

function sendDialError(res: any, err: any) {
  if (err instanceof DialBlockedError) {
    res.status(dialBlockedHttpStatus(err)).json({ error: err.message, reason: err.code });
    return;
  }
  if (err instanceof SpendLimitError) {
    res.status(spendLimitHttpStatus(err)).json({ error: err.message, reason: err.code });
    return;
  }
  const status = err instanceof TelephonyNotConfiguredError ? 400 : 500;
  res.status(status).json({ error: err.message || "Failed to place call" });
}

router.post("/contacts/:id/dial", dialRateLimit, async (req, res) => {
  const userId = req.userId!;

  const contact = await db.query.contactsTable.findFirst({
    where: and(eq(contactsTable.id, parseInt(req.params.id)), eq(contactsTable.userId, userId)),
  });

  if (!contact) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  const campaignId = await ownedCampaignId(userId, req.body?.campaignId);
  if (campaignId === undefined) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  const agentConfig = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });
  const baseUrl = getBaseUrl(req);

  try {
    const placed = await placeOutboundCall({
      userId,
      contactId: contact.id,
      campaignId,
      phone: contact.phone,
      aiModel: agentConfig?.aiModel || "gpt-4o-mini",
      baseUrl,
    });

    await db.update(contactsTable)
      .set({ status: "called", lastCalledAt: new Date(), updatedAt: new Date() })
      .where(eq(contactsTable.id, contact.id));

    res.json({ callSid: placed.providerCallId, callLogId: placed.callLogId, status: "dialing" });
  } catch (err: any) {
    sendDialError(res, err);
  }
});

router.post("/campaigns/:id/dial-next", dialRateLimit, async (req, res) => {
  const userId = req.userId!;
  const campaignId = parseInt(req.params.id);

  if (isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  try {
    const baseUrl = getBaseUrl(req);
    const result = await dialNextForCampaign(campaignId, userId, baseUrl);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to dial next contact" });
  }
});

// ── Dial by raw phone number (Dialer UI) ──
router.post("/dial/phone", dialRateLimit, async (req, res) => {
  const userId = req.userId!;
  const { phone } = req.body;

  if (!phone) {
    res.status(400).json({ error: "phone is required" });
    return;
  }

  const agentConfig = await db.query.agentConfigsTable.findFirst({
    where: eq(agentConfigsTable.userId, userId),
  });
  const baseUrl = getBaseUrl(req);

  try {
    const placed = await placeOutboundCall({
      userId,
      phone,
      aiModel: agentConfig?.aiModel || "gpt-4o-mini",
      baseUrl,
    });
    res.json({ callSid: placed.providerCallId, callLogId: placed.callLogId, status: "dialing" });
  } catch (err: any) {
    sendDialError(res, err);
  }
});


// ── Internal: End an active call (JWT auth — used by the Dialer UI) ──
router.post("/dial/calls/:id/end", async (req, res) => {
  const userId = req.userId!;
  const callId = parseInt(req.params.id);

  if (isNaN(callId)) {
    res.status(400).json({ error: "Invalid call ID" });
    return;
  }

  const call = await db.query.callLogsTable.findFirst({
    where: and(eq(callLogsTable.id, callId), eq(callLogsTable.userId, userId)),
  });

  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }

  if (call.endedAt) {
    // Already ended — treat as success so the UI can proceed
    res.json({ success: true, message: "Call already ended" });
    return;
  }

  const agentConfig = await db.query.agentConfigsTable.findFirst({
    where: eq(agentConfigsTable.userId, userId),
  });

  try {
    if (call.callSid) {
      const telephony = await resolveTelephonyForUser(userId, call.phone || "");
      if (telephony.provider === "EXOTEL") {
        await exotelHangupCall(telephony.credentials, call.callSid);
      } else if (agentConfig?.twilioAccountSid && agentConfig?.twilioAuthToken) {
        const authToken = twilioAuthTokenFor(agentConfig);
        if (authToken) {
          const client = getTwilioClient(agentConfig.twilioAccountSid, authToken);
          await client.calls(call.callSid).update({ status: "completed" });
        }
      }
    }

    const formattedTranscript = (call?.liveTranscript && Array.isArray(call.liveTranscript))
      ? call.liveTranscript
          .map((turn: any) => `${turn.role === "user" ? "Caller" : "Agent"}: ${turn.content}`)
          .join("\n\n")
      : null;

    await db.update(callLogsTable)
      .set({
        endedAt: new Date(),
        outcome: "answered",
        ...(formattedTranscript ? { transcript: formattedTranscript } : {}),
      })
      .where(eq(callLogsTable.id, callId));

    res.json({ success: true, message: `Call ${callId} ended` });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to end call" });
  }
});

// ── Internal: Transfer active call to CRM agent (JWT auth — used by Dialer UI) ──
router.post("/dial/calls/:id/transfer", callTransferRateLimit, async (req, res) => {
  const userId = req.userId!;
  const callId = parseInt(req.params.id);

  if (isNaN(callId)) {
    res.status(400).json({ error: "Invalid call ID" });
    return;
  }

  if (!(await hasCrmIntegration(userId))) {
    res.status(400).json({
      error: "CRM not connected. Generate an API key under Dialer → API Integration and connect your CRM.",
    });
    return;
  }

  const call = await db.query.callLogsTable.findFirst({
    where: and(eq(callLogsTable.id, callId), eq(callLogsTable.userId, userId)),
  });

  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }

  if (call.endedAt) {
    res.status(400).json({ error: "Call has already ended" });
    return;
  }

  if (!call.callSid) {
    res.status(400).json({ error: "Call SID not available — call may not have connected yet" });
    return;
  }

  const { crmAgentId, reason, transferType = "cold", briefingMessage } = req.body;

  if (!crmAgentId) {
    res.status(400).json({ error: "crmAgentId is required" });
    return;
  }

  const agent = await db.query.crmAgentsTable.findFirst({
    where: and(
      eq(crmAgentsTable.userId, userId),
      eq(crmAgentsTable.crmAgentId, crmAgentId),
    ),
  });

  if (!agent) {
    res.status(404).json({ error: `CRM agent ${crmAgentId} not found` });
    return;
  }

  const targetPhone = agent.phone || agent.sipUri;
  if (!targetPhone) {
    res.status(400).json({ error: `CRM agent ${crmAgentId} has no phone or SIP URI configured` });
    return;
  }

  const result = await executeTransfer(userId, {
    callId,
    callSid: call.callSid,
    transferTo: targetPhone,
    reason: reason || "Manual transfer from dialer",
    transferType,
    briefingMessage,
    crmAgentId,
  });

  if (result.success) {
    res.json({
      success: true,
      conferenceSid: result.conferenceSid,
      crmAgentId,
      message: `Call ${callId} transfer initiated to ${agent.name}. CRM will receive transcript and contact details.`,
    });
  } else {
    res.status(500).json({ success: false, error: result.error });
  }
});

/**
 * The Twilio call resource (fetched with the tenant's credentials) carries the
 * billed duration and, once Twilio has rated the call, its price. Both are
 * provider evidence for the call's telephony ledger entry.
 */
async function recordTwilioApiEvidence(
  call: typeof callLogsTable.$inferSelect,
  twilioCall: { price?: string | null; priceUnit?: string | null },
  durationSecs: number,
) {
  const price = twilioCall.price == null ? NaN : Math.abs(Number(twilioCall.price));
  const currency = typeof twilioCall.priceUnit === "string" && /^[A-Z]{3}$/.test(twilioCall.priceUnit) ? twilioCall.priceUnit : null;
  try {
    await recordCallTelephony(call, {
      provider: call.direction === "outbound" ? await outboundTelephonyProvider(call.userId) : "twilio",
      seconds: durationSecs,
      measurement: "actual",
      outcome: durationSecs > 0 ? "charged" : "not_charged",
      providerCost: Number.isFinite(price) && currency ? { amount: price, currency } : null,
      reason: "provider_api",
    });
    await settleCall(call.id, "call_completed");
  } catch (err) {
    logger.error({ err, callLogId: call.id }, "Call telephony evidence recording failed");
  }
}

// ── Internal: Poll call status + live transcript (JWT auth — used by Dialer UI) ──
router.get("/dial/calls/:id/live", async (req, res) => {
  const userId = req.userId!;
  const callId = parseInt(req.params.id);

  if (isNaN(callId)) {
    res.status(400).json({ error: "Invalid call ID" });
    return;
  }

  const call = await db.query.callLogsTable.findFirst({
    where: and(eq(callLogsTable.id, callId), eq(callLogsTable.userId, userId)),
  });

  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }

  let status = call.endedAt ? "ended" : "dialing";
  let outcome = call.outcome;
  let endedAt = call.endedAt;

  // Exotel calls report status via /api/exotel/status callback — never poll Twilio for them.
  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.ownerId, userId),
  });
  const isExotel = tenant?.telephonyType === "EXOTEL";

  if (tenant?.telephonyType === "VOBIZ_SIP") {
    res.status(503).json({ error: "Vobiz SIP call status requires the LiveKit integration." });
    return;
  }

  if (!call.endedAt && call.callSid && !isExotel) {
    const agentConfig = await db.query.agentConfigsTable.findFirst({
      where: eq(agentConfigsTable.userId, userId),
    });

    const authToken = agentConfig ? twilioAuthTokenFor(agentConfig) : null;
    if (agentConfig?.twilioAccountSid && authToken) {
      try {
        const client = getTwilioClient(agentConfig.twilioAccountSid, authToken);
        const twilioCall = await client.calls(call.callSid).fetch();
        const durationSecs = parseInt(String(twilioCall.duration ?? "0"), 10) || 0;
        const endTime = twilioCall.endTime ?? null;
        const isTerminal = !!endTime
          || TWILIO_TERMINAL_STATUSES.has(twilioCall.status)
          || (twilioCall.status === "completed" && durationSecs === 0);

        status = mapTwilioCallStatus(twilioCall.status, call.endedAt, endTime, durationSecs);

        if (isTerminal) {
          await recordTwilioApiEvidence(call, twilioCall, durationSecs);
        }
        if (isTerminal && !call.endedAt) {
          await syncCallEndFromTwilio(call.id, twilioCall.status, endTime, durationSecs);
          endedAt = endTime ?? new Date();
          outcome = TWILIO_OUTCOME_MAP[twilioCall.status]
            ?? (durationSecs > 0 ? "answered" : "no_answer");
        }
      } catch (err: any) {
        // Call resource gone or unreachable — treat as ended if it was in progress
        if (err?.status === 404 || err?.code === 20404) {
          status = "ended";
          if (!call.endedAt) {
            await syncCallEndFromTwilio(call.id, "no-answer", new Date(), 0);
            endedAt = new Date();
            outcome = "no_answer";
          }
        }
      }
    }
  }

  res.json({
    callId: call.id,
    callSid: call.callSid,
    phone: call.phone,
    status,
    outcome,
    liveTranscript: call.liveTranscript || [],
    transcript: call.transcript,
    transferredTo: call.transferredTo,
    endedAt,
    startedAt: call.startedAt,
    duration: call.duration,
  });
});

export default router;
