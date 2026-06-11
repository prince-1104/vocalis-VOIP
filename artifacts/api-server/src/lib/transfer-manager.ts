import twilio from "twilio";
import { db, callLogsTable, crmAgentsTable, agentConfigsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
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
  crmAgentId?: string;
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
      data: {
        transferTo: request.transferTo,
        reason: request.reason,
        transferType: request.transferType,
        crmAgentId: request.crmAgentId,
      },
      metadata: callLog?.crmMetadata as Record<string, unknown> | undefined,
      timestamp: new Date().toISOString(),
    });

    const lang = agentConfig?.language || "en-US";

    // Update the active call to join a conference (caller side)
    // This modifies the in-progress call to put the caller into a conference room
    await client.calls(request.callSid).update({
      twiml: `<Response>
        <Say>Please hold while I connect you with a specialist.</Say>
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

    // Emit transferred event
    crmEventBus.emitCallEvent({
      type: "call.transferred",
      callId: request.callId,
      callSid: request.callSid,
      data: {
        conferenceSid: conferenceName,
        agentCallSid: agentCall.sid,
        transferTo: request.transferTo,
        reason: request.reason,
      },
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
