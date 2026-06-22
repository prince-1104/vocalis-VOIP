import twilio from "twilio";
import { db, callLogsTable, crmAgentsTable, agentConfigsTable, contactsTable, crmApiKeysTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { CallLog } from "@workspace/db";
import { crmEventBus } from "./crm-event-bus";
import { logger } from "./logger";

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

function getBaseUrl(req?: any): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    const first = domains.split(",")[0].trim();
    return `https://${first}`;
  }
  if (req) {
    const host = req.headers?.host || "localhost";
    return `https://${host}`;
  }
  return process.env.BASE_URL || "https://localhost";
}

export async function executeTransfer(
  userId: number,
  request: TransferRequest,
): Promise<{ success: boolean; conferenceSid?: string; error?: string }> {
  try {
    const agentConfig = await db.query.agentConfigsTable.findFirst({
      where: eq(agentConfigsTable.userId, userId),
    });

    if (!agentConfig?.twilioAccountSid || !agentConfig?.twilioAuthToken) {
      return { success: false, error: "Twilio credentials not configured" };
    }

    if (!agentConfig.phoneNumber) {
      return { success: false, error: "Twilio phone number not configured" };
    }

    const client = twilio(agentConfig.twilioAccountSid, agentConfig.twilioAuthToken);
    const conferenceName = `crm-transfer-${request.callId}-${Date.now()}`;
    const baseUrl = getBaseUrl();

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

    const lang = agentConfig?.language || "en-US";
    const callerMessage = request.callerMessage
      || "Please wait, your call is being transferred to our specialist. Please stay on the line.";

    // Update the active call to join a conference (caller side)
    await client.calls(request.callSid).update({
      twiml: `<Response>
        <Say>${escapeXml(callerMessage)}</Say>
        <Dial>
          <Conference statusCallback="${baseUrl}/api/crm/conference-status?callId=${request.callId}"
                      statusCallbackEvent="join leave end"
                      startConferenceOnEnter="false"
                      endConferenceOnExit="true"
                      beep="false"
                      waitUrl="${baseUrl}/api/twilio/hold-music?lang=${encodeURIComponent(lang)}"
                      waitMethod="POST">
            ${conferenceName}
          </Conference>
        </Dial>
      </Response>`,
    });

    // Dial out to the CRM agent and connect them to the same conference
    const agentCall = await client.calls.create({
      to: request.transferTo,
      from: agentConfig.phoneNumber,
      twiml: `<Response>
        ${request.briefingMessage ? `<Say>${request.briefingMessage}</Say>` : ""}
        <Dial>
          <Conference statusCallback="${baseUrl}/api/crm/conference-status?callId=${request.callId}"
                      statusCallbackEvent="join leave end"
                      startConferenceOnEnter="true"
                      endConferenceOnExit="false"
                      beep="false">
            ${conferenceName}
          </Conference>
        </Dial>
      </Response>`,
      statusCallback: `${baseUrl}/api/crm/agent-call-status?callId=${request.callId}`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
    });

    // Update call log with transfer info
    await db.update(callLogsTable)
      .set({
        conferenceSid: conferenceName,
        transferredTo: request.transferTo,
        transferReason: request.reason,
        transferredAt: new Date(),
      })
      .where(eq(callLogsTable.id, request.callId));

    // Update CRM agent's current call count
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
