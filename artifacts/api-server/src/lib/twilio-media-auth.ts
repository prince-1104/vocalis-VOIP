import type { RequestHandler } from "express";
import { db, agentConfigsTable, callLogsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import {
  bindTwilioCallSid,
  signingKey,
  MediaAuthorizationError,
} from "./media-session";
import {
  activeTwilioTenantId,
  hasValidTwilioSignature,
  TWILIO_CALL_SID,
} from "./twilio-webhook-auth";

declare global {
  namespace Express {
    interface Request {
      verifiedMediaOwnerId?: number;
    }
  }
}

// Media-credential issuers. Call-bound callbacks use verifyTwilioCallWebhook.
export function twilioMediaIssuer(
  kind: "inbound" | "outbound" | "widget",
): RequestHandler {
  return async (req, res, next) => {
    try {
      signingKey();
      let agents: (typeof agentConfigsTable.$inferSelect)[];
      let callId: number | undefined;
      if (kind === "outbound") {
        const raw = req.query.callLogId;
        if (
          typeof raw !== "string" ||
          !/^[1-9][0-9]*$/.test(raw) ||
          !Number.isSafeInteger(Number(raw))
        )
          throw new MediaAuthorizationError();
        callId = Number(raw);
        const call = await db.query.callLogsTable.findFirst({
          where: eq(callLogsTable.id, callId),
        });
        if (!call || call.endedAt || call.direction !== "outbound")
          throw new MediaAuthorizationError();
        agents = await db
          .select()
          .from(agentConfigsTable)
          .where(eq(agentConfigsTable.userId, call.userId))
          .limit(2);
      } else {
        const identifier =
          kind === "widget" ? req.body.ApplicationSid : req.body.To;
        if (typeof identifier !== "string" || !identifier)
          throw new MediaAuthorizationError();
        agents = await db
          .select()
          .from(agentConfigsTable)
          .where(
            eq(
              kind === "widget"
                ? agentConfigsTable.twilioTwimlAppSid
                : agentConfigsTable.phoneNumber,
              identifier,
            ),
          )
          .limit(2);
      }
      if (agents.length !== 1) throw new MediaAuthorizationError();
      const agent = agents[0];
      if (
        (await activeTwilioTenantId(agent)) === null ||
        typeof req.body.CallSid !== "string" ||
        !TWILIO_CALL_SID.test(req.body.CallSid) ||
        !hasValidTwilioSignature(req, agent)
      ) {
        throw new MediaAuthorizationError();
      }
      if (callId !== undefined)
        await bindTwilioCallSid(callId, req.body.CallSid);
      req.verifiedMediaOwnerId = agent.userId;
      next();
    } catch {
      res.status(403).json({ error: "Media access denied" });
    }
  };
}

export async function getOrCreateVerifiedCall(
  values: typeof callLogsTable.$inferInsert,
) {
  if (!values.callSid) throw new MediaAuthorizationError();
  return db.transaction(async (tx) => {
    // Serialize retries of the same verified provider callback, including across replicas.
    await tx.execute(
      sql`select pg_advisory_xact_lock(${values.userId}, hashtext(${values.callSid}))`,
    );
    const existing = await tx.query.callLogsTable.findFirst({
      where: and(
        eq(callLogsTable.userId, values.userId),
        eq(callLogsTable.callSid, values.callSid!),
      ),
    });
    if (existing) {
      if (existing.endedAt || existing.direction !== values.direction)
        throw new MediaAuthorizationError();
      return existing;
    }
    const [created] = await tx.insert(callLogsTable).values(values).returning();
    return created;
  });
}
