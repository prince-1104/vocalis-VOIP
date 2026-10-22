import { db, callLogsTable, crmAgentsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { mediaPublicUrl } from "./media-session";

type Connection = typeof db;

/** Twilio-facing transfer URLs, always on the configured canonical origin. */
export function transferCallbackUrls(callId: number, conferenceName: string, lang: string) {
  const binding = `callId=${callId}&transfer=${encodeURIComponent(conferenceName)}`;
  return {
    conferenceStatus: mediaPublicUrl(`/api/twilio/conference-status?${binding}`),
    agentCallStatus: mediaPublicUrl(`/api/twilio/agent-call-status?${binding}`),
    holdMusic: mediaPublicUrl(`/api/twilio/hold-music?lang=${encodeURIComponent(lang)}`),
  };
}

/** Compare-and-set so concurrent adjustments can never lose an update or go negative. */
async function adjustAgentCalls(connection: Connection, ownerId: number, agentId: number, delta: 1 | -1): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const agent = await connection.query.crmAgentsTable.findFirst({
      where: and(eq(crmAgentsTable.id, agentId), eq(crmAgentsTable.userId, ownerId)),
    });
    if (!agent) return false;
    const next = Math.max(0, agent.currentCalls + delta);
    if (next === agent.currentCalls) return false;
    const updated = await connection.update(crmAgentsTable)
      .set({ currentCalls: next })
      .where(and(eq(crmAgentsTable.id, agent.id), eq(crmAgentsTable.currentCalls, agent.currentCalls)))
      .returning({ id: crmAgentsTable.id });
    if (updated.length === 1) return true;
  }
  return false;
}

/**
 * Binds a new transfer (conference) to the call and reserves the agent slot.
 * Must run before any provider request so early callbacks find the binding.
 */
export async function reserveTransferSlot(
  callId: number,
  ownerId: number,
  conferenceName: string,
  crmAgentId?: string,
  connection: Connection = db,
): Promise<void> {
  const previous = await connection.query.callLogsTable.findFirst({
    where: and(eq(callLogsTable.id, callId), eq(callLogsTable.userId, ownerId)),
  });
  if (previous?.conferenceSid && !previous.transferReleasedAt)
    await releaseTransferSlot(callId, previous.conferenceSid, connection);
  const agent = crmAgentId
    ? await connection.query.crmAgentsTable.findFirst({
        where: and(eq(crmAgentsTable.userId, ownerId), eq(crmAgentsTable.crmAgentId, crmAgentId)),
      })
    : undefined;
  const reserved = agent ? await adjustAgentCalls(connection, ownerId, agent.id, 1) : false;
  await connection.update(callLogsTable)
    .set({
      conferenceSid: conferenceName,
      transferAgentId: reserved ? agent!.id : null,
      transferReleasedAt: null,
    })
    .where(and(eq(callLogsTable.id, callId), eq(callLogsTable.userId, ownerId)));
}

/**
 * Releases the slot reserved by exactly this transfer, at most once. Stale
 * events from an earlier conference on the same call do not match.
 */
export async function releaseTransferSlot(
  callId: number,
  conferenceName: string,
  connection: Connection = db,
): Promise<boolean> {
  const [claimed] = await connection.update(callLogsTable)
    .set({ transferReleasedAt: new Date() })
    .where(and(
      eq(callLogsTable.id, callId),
      eq(callLogsTable.conferenceSid, conferenceName),
      isNull(callLogsTable.transferReleasedAt),
    ))
    .returning({ userId: callLogsTable.userId, transferAgentId: callLogsTable.transferAgentId });
  if (!claimed?.transferAgentId) return false;
  return adjustAgentCalls(connection, claimed.userId, claimed.transferAgentId, -1);
}

/**
 * Single conditional claim for terminal call finalization: exactly one caller
 * (status callback, stream close, retry) wins and performs the side effects.
 */
export async function claimCallFinalization(
  callLogId: number,
  values: Partial<typeof callLogsTable.$inferInsert>,
  connection: Connection = db,
): Promise<boolean> {
  const finalized = await connection.update(callLogsTable)
    .set({ ...values, finalizedAt: new Date() })
    .where(and(eq(callLogsTable.id, callLogId), isNull(callLogsTable.finalizedAt)))
    .returning({ id: callLogsTable.id });
  return finalized.length === 1;
}
