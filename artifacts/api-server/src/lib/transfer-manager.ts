import twilio from "twilio";
import { db, callLogsTable, crmAgentsTable, agentConfigsTable, contactsTable, crmApiKeysTable, tenantsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { CallLog } from "@workspace/db";
import { crmEventBus } from "./crm-event-bus";
import { logger } from "./logger";
import { twilioAuthTokenFor } from "./tenant-credentials";
import { requestExotelTransfer } from "./telephony/exotel-stream-registry";
import { releaseTransferSlot, reserveTransferSlot, transferCallbackUrls } from "./transfer-slots";

// ── Transfer Manager ───────────────────────────────────────────────────
// Handles transferring active Twilio calls to CRM agents using Twilio
// Conference. Supports both cold and warm transfers.
//
// Cold: AI says goodbye → caller enters conference → CRM agent joins
// Warm: AI briefs agent → all three in conference → AI drops out

export interface TransferRequest {
  callId: number;
  callSid: string;
  transferTo: string;           // phone number or SIP URI
  reason: string;
  transferType: "cold" | "warm";
  briefingMessage?: string;     // AI message to play to the agent (warm transfer)
  callerMessage?: string;         // message played to caller before conference
  crmAgentId?: string;
}

/** True when the tenant has at least one active CRM API key (external CRM connected). */
export async function hasCrmIntegration(userId: number): Promise<boolean> {
  const keys = await db.select({ id: crmApiKeysTable.id })
    .from(crmApiKeysTable)
    .where(and(eq(crmApiKeysTable.userId, userId), eq(crmApiKeysTable.isActive, true)))
    .limit(1);
  return keys.length > 0;
}

/** Build webhook payload fields sent to the CRM on transfer (transcript + contact). */
export async function buildTransferEventData(
  call: CallLog,
  userId: number,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  let contactDetails: Record<string, unknown> = { phone: call.phone };

  if (call.contactId) {
    const contact = await db.query.contactsTable.findFirst({
      where: eq(contactsTable.id, call.contactId),
    });
    if (contact) {
      contactDetails = {
        id: contact.id,
        phone: contact.phone,
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        company: contact.company,
        status: contact.status,
        notes: contact.notes,
      };
    }
  }

  let agent: { crmAgentId: string; name: string; specialization: string | null } | null = null;
  const crmAgentId = (extra.crmAgentId as string | undefined) || undefined;
  if (crmAgentId) {
    const row = await db.query.crmAgentsTable.findFirst({
      where: and(eq(crmAgentsTable.userId, userId), eq(crmAgentsTable.crmAgentId, crmAgentId)),
    });
    if (row) {
      agent = { crmAgentId: row.crmAgentId, name: row.name, specialization: row.specialization };
    }
  }

  return {
    ...extra,
    crmContactId: call.crmContactId,
    contact: contactDetails,
    liveTranscript: call.liveTranscript || [],
    transcript: call.transcript,
    aiSummary: call.aiSummary,
    phone: call.phone,
    direction: call.direction,
    agent,
  };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Exotel transfer — flow based.
 *
 * Exotel cannot add a third party to a live Voicebot stream over REST the way
 * Twilio Conference can. Instead we record the destination and close the
 * Voicebot WebSocket, which makes Exotel advance to the next applet — a Connect
 * applet whose Dynamic URL (/api/exotel/connect) returns this destination.
 */
async function executeExotelTransfer(
  userId: number,
  request: TransferRequest,
): Promise<{ success: boolean; conferenceSid?: string; error?: string }> {
  try {
    const callLog = await db.query.callLogsTable.findFirst({
      where: eq(callLogsTable.id, request.callId),
    });

    requestExotelTransfer(String(request.callId), {
      destination: request.transferTo,
      reason: request.reason,
      crmAgentId: request.crmAgentId,
      transferType: request.transferType,
      createdAt: Date.now(),
    });

    await db.update(callLogsTable)
      .set({
        transferredTo: request.transferTo,
        transferReason: request.reason,
        transferredAt: new Date(),
      })
      .where(eq(callLogsTable.id, request.callId));

    if (request.crmAgentId) {
      const agent = await db.query.crmAgentsTable.findFirst({
        where: and(
          eq(crmAgentsTable.userId, userId),
          eq(crmAgentsTable.crmAgentId, request.crmAgentId),
        ),
      });
      if (agent) {
        await db.update(crmAgentsTable)
          .set({ currentCalls: agent.currentCalls + 1 })
          .where(eq(crmAgentsTable.id, agent.id));
      }
    }

    crmEventBus.emitCallEvent({
      type: "call.transferred",
      callId: request.callId,
      callSid: request.callSid,
      userId,
      data: await buildTransferEventData(callLog!, userId, {
        transferTo: request.transferTo,
        reason: request.reason,
        crmAgentId: request.crmAgentId,
        provider: "exotel",
      }),
      metadata: callLog?.crmMetadata as Record<string, unknown> | undefined,
      timestamp: new Date().toISOString(),
    });

    logger.info(
      { callId: request.callId, isSipTarget: request.transferTo.startsWith("sip:") },
      "Exotel transfer initiated (caller will be connected via Connect applet)",
    );

    return { success: true };
  } catch (err: any) {
    logger.error({ err, callId: request.callId }, "Exotel transfer failed");
    crmEventBus.emitCallEvent({
      type: "call.error",
      callId: request.callId,
      callSid: request.callSid,
      userId,
      data: { error: `Transfer failed: ${err.message}` },
      timestamp: new Date().toISOString(),
    });
    return { success: false, error: err.message };
  }
}

export async function executeTransfer(
  userId: number,
  request: TransferRequest,
): Promise<{ success: boolean; conferenceSid?: string; error?: string }> {
  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.ownerId, userId),
  });

  if (tenant?.telephonyType === "EXOTEL") {
    return executeExotelTransfer(userId, request);
  }

  try {
    const agentConfig = await db.query.agentConfigsTable.findFirst({
      where: eq(agentConfigsTable.userId, userId),
    });

    const authToken = agentConfig ? twilioAuthTokenFor(agentConfig) : null;
    if (!agentConfig?.twilioAccountSid || !authToken) {
      return { success: false, error: "Twilio credentials not configured" };
    }

    if (!agentConfig.phoneNumber) {
      return { success: false, error: "Twilio phone number not configured" };
    }

    const client = twilio(agentConfig.twilioAccountSid, authToken);
    const conferenceName = `crm-transfer-${request.callId}-${Date.now()}`;
    const lang = agentConfig?.language || "en-US";
    const callbacks = transferCallbackUrls(request.callId, conferenceName, lang);

    // Emit transferring event
    const callLog = await db.query.callLogsTable.findFirst({
      where: eq(callLogsTable.id, request.callId),
    });

    crmEventBus.emitCallEvent({
      type: "call.transferring",
      callId: request.callId,
      callSid: request.callSid,
      userId,
      data: await buildTransferEventData(callLog!, userId, {
        transferTo: request.transferTo,
        reason: request.reason,
        transferType: request.transferType,
        crmAgentId: request.crmAgentId,
      }),
      metadata: callLog?.crmMetadata as Record<string, unknown> | undefined,
      timestamp: new Date().toISOString(),
    });

    const callerMessage = request.callerMessage
      || "Please wait, your call is being transferred to our specialist. Please stay on the line.";

    await reserveTransferSlot(request.callId, userId, conferenceName, request.crmAgentId);

    let agentCall;
    try {
      // Update the active call to join a conference (caller side)
      await client.calls(request.callSid).update({
        twiml: `<Response>
        <Say>${escapeXml(callerMessage)}</Say>
        <Dial>
          <Conference statusCallback="${escapeXml(callbacks.conferenceStatus)}"
                      statusCallbackEvent="join leave end"
                      startConferenceOnEnter="false"
                      endConferenceOnExit="true"
                      beep="false"
                      waitUrl="${escapeXml(callbacks.holdMusic)}"
                      waitMethod="POST">
            ${conferenceName}
          </Conference>
        </Dial>
      </Response>`,
      });

      // Dial out to the CRM agent and connect them to the same conference
      agentCall = await client.calls.create({
        to: request.transferTo,
        from: agentConfig.phoneNumber,
        twiml: `<Response>
        ${request.briefingMessage ? `<Say>${request.briefingMessage}</Say>` : ""}
        <Dial>
          <Conference statusCallback="${escapeXml(callbacks.conferenceStatus)}"
                      statusCallbackEvent="join leave end"
                      startConferenceOnEnter="true"
                      endConferenceOnExit="false"
                      beep="false">
            ${conferenceName}
          </Conference>
        </Dial>
      </Response>`,
        statusCallback: callbacks.agentCallStatus,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
      });
    } catch (err) {
      await releaseTransferSlot(request.callId, conferenceName).catch(() => false);
      throw err;
    }

    // Update call log with transfer info
    await db.update(callLogsTable)
      .set({
        transferredTo: request.transferTo,
        transferReason: request.reason,
        transferredAt: new Date(),
      })
      .where(eq(callLogsTable.id, request.callId));

    // Emit transferred event — CRM uses crmAgentId to show on the agent's dashboard
    crmEventBus.emitCallEvent({
      type: "call.transferred",
      callId: request.callId,
      callSid: request.callSid,
      userId,
      data: await buildTransferEventData(callLog!, userId, {
        conferenceSid: conferenceName,
        agentCallSid: agentCall.sid,
        transferTo: request.transferTo,
        reason: request.reason,
        crmAgentId: request.crmAgentId,
      }),
      metadata: callLog?.crmMetadata as Record<string, unknown> | undefined,
      timestamp: new Date().toISOString(),
    });

    logger.info(
      { callId: request.callId, conferenceName, agentCallSid: agentCall.sid },
      "Call transfer executed",
    );

    return { success: true, conferenceSid: conferenceName };
  } catch (err: any) {
    logger.error({ err, callId: request.callId }, "Call transfer failed");

    crmEventBus.emitCallEvent({
      type: "call.error",
      callId: request.callId,
      callSid: request.callSid,
      userId,
      data: { error: `Transfer failed: ${err.message}` },
      timestamp: new Date().toISOString(),
    });

    return { success: false, error: err.message };
  }
}

export async function findBestAgent(
  userId: number,
  intent: string,
): Promise<{ agentId: string; phone: string; name: string } | null> {
  const agents = await db.select().from(crmAgentsTable).where(
    and(
      eq(crmAgentsTable.userId, userId),
      eq(crmAgentsTable.isAvailable, true),
    ),
  );

  // Find agent whose intents include the detected intent
  // and who has capacity (currentCalls < maxConcurrentCalls)
  const candidates = agents.filter(a => {
    const agentIntents = (a.intents as string[]) || [];
    return (
      agentIntents.includes(intent) &&
      a.currentCalls < a.maxConcurrentCalls &&
      a.phone // must have a phone number
    );
  });

  if (candidates.length === 0) {
    // Fallback: any available agent with capacity
    const fallback = agents.find(a => a.currentCalls < a.maxConcurrentCalls && a.phone);
    if (fallback) {
      return { agentId: fallback.crmAgentId, phone: fallback.phone!, name: fallback.name };
    }
    return null;
  }

  // Pick the agent with the fewest current calls (load balancing)
  candidates.sort((a, b) => a.currentCalls - b.currentCalls);
  const best = candidates[0];
  return { agentId: best.crmAgentId, phone: best.phone!, name: best.name };
}
