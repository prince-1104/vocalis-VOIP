import type { Request, RequestHandler } from "express";
import twilio from "twilio";
import {
  db,
  agentConfigsTable,
  callLogsTable,
  tenantsTable,
} from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { mediaPublicUrl } from "./media-session";
import { logger } from "./logger";
import { twilioAuthTokenFor } from "./tenant-credentials";

type AgentConfig = typeof agentConfigsTable.$inferSelect;
type CallLog = typeof callLogsTable.$inferSelect;

export const TWILIO_CALL_SID = /^CA[a-fA-F0-9]{32}$/;

export interface VerifiedTwilioWebhook {
  call: CallLog;
  tenantId: number;
}

declare global {
  namespace Express {
    interface Request {
      twilioWebhook?: VerifiedTwilioWebhook;
    }
  }
}

class TwilioWebhookRejected extends Error {
  constructor(readonly reason: string) {
    super("Twilio webhook rejected");
  }
}
function reject(reason: string): never {
  throw new TwilioWebhookRejected(reason);
}

/**
 * The tenant that owns `agent` must be the single active, non-Exotel tenant
 * for that owner, and the agent must hold Twilio credentials.
 */
export async function activeTwilioTenantId(
  agent: AgentConfig,
): Promise<number | null> {
  if (!agent.twilioAccountSid || !agent.twilioAuthToken) return null;
  const tenants = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.ownerId, agent.userId))
    .limit(2);
  if (
    tenants.length !== 1 ||
    tenants[0].status !== "active" ||
    tenants[0].telephonyType === "EXOTEL" ||
    tenants[0].telephonyType === "VOBIZ_SIP"
  )
    return null;
  return tenants[0].id;
}

/**
 * Validates X-Twilio-Signature against the configured canonical public URL
 * (never the request Host header) and binds the request to the agent's account.
 */
export function hasValidTwilioSignature(
  req: Request,
  agent: AgentConfig,
): boolean {
  const params = req.body ?? {};
  const signature = req.get("x-twilio-signature");
  if (
    !agent.twilioAccountSid ||
    typeof signature !== "string" ||
    signature.length === 0 ||
    params.AccountSid !== agent.twilioAccountSid
  )
    return false;
  const authToken = twilioAuthTokenFor(agent);
  return (
    !!authToken &&
    twilio.validateRequest(
      authToken,
      signature,
      mediaPublicUrl(req.originalUrl),
      params,
    )
  );
}

function parseCallId(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id <= 2_147_483_647 ? id : null;
}

async function resolveCall(
  req: Request,
  options: TwilioCallWebhookOptions,
): Promise<CallLog> {
  const raw = req.query[options.callIdParam];
  if (raw !== undefined) {
    const id = parseCallId(raw) ?? reject("invalid_call_id");
    return (
      (await db.query.callLogsTable.findFirst({
        where: eq(callLogsTable.id, id),
      })) ?? reject("unknown_call")
    );
  }
  const sid = req.body?.CallSid;
  if (!options.allowCallSidLookup || typeof sid !== "string" || !TWILIO_CALL_SID.test(sid))
    reject("invalid_call_id");
  const matches = await db
    .select()
    .from(callLogsTable)
    .where(eq(callLogsTable.callSid, sid))
    .limit(2);
  if (matches.length !== 1) reject("unknown_call");
  return matches[0];
}

async function bindCallSid(call: CallLog, sid: string): Promise<void> {
  if (call.callSid === sid) return;
  if (call.callSid) reject("call_binding");
  await db
    .update(callLogsTable)
    .set({ callSid: sid })
    .where(and(eq(callLogsTable.id, call.id), isNull(callLogsTable.callSid)));
  const bound = await db.query.callLogsTable.findFirst({
    where: eq(callLogsTable.id, call.id),
  });
  if (bound?.callSid !== sid) reject("call_binding");
  call.callSid = sid;
}

export interface TwilioCallWebhookOptions {
  /** Short label for logs; never a URL. */
  route: string;
  callIdParam: "callLogId" | "callId";
  /** Status callbacks may arrive without our query parameter (number-level config). */
  allowCallSidLookup?: boolean;
  /**
   * match: CallSid must equal the bound call SID.
   * bind:  as match, but an unbound outbound call may be bound after verification.
   * none:  the callback is for a different leg (conference / agent leg).
   */
  callSid: "match" | "bind" | "none";
  /** Terminal/transfer callbacks legitimately arrive after the AI leg ended. */
  allowEnded?: boolean;
}

/**
 * Authenticates a Twilio callback that refers to one of our call logs.
 * Credentials come only from the call's owner — never from caller-supplied
 * tenant/owner identifiers — and every check runs before any state change.
 */
export function verifyTwilioCallWebhook(
  options: TwilioCallWebhookOptions,
): RequestHandler {
  return async (req, res, next) => {
    const startedAt = Date.now();
    try {
      try {
        mediaPublicUrl("/");
      } catch {
        reject("canonical_url_config");
      }
      const call = await resolveCall(req, options);
      if (!options.allowEnded && call.endedAt) reject("call_ended");
      const agents = await db
        .select()
        .from(agentConfigsTable)
        .where(eq(agentConfigsTable.userId, call.userId))
        .limit(2);
      if (agents.length !== 1) reject("credentials");
      const tenantId =
        (await activeTwilioTenantId(agents[0])) ?? reject("tenant");
      if (!hasValidTwilioSignature(req, agents[0])) reject("signature");
      if (options.callSid !== "none") {
        const sid = req.body?.CallSid;
        if (typeof sid !== "string" || !TWILIO_CALL_SID.test(sid))
          reject("call_binding");
        if (options.callSid === "bind") await bindCallSid(call, sid);
        else if (call.callSid !== sid) reject("call_binding");
      }
      req.twilioWebhook = { call, tenantId };
      next();
    } catch (err) {
      logger.warn(
        {
          event: "twilio_webhook_rejected",
          route: options.route,
          reason: err instanceof TwilioWebhookRejected ? err.reason : "error",
          latencyMs: Date.now() - startedAt,
        },
        "Twilio webhook rejected",
      );
      res.status(403).type("text/plain").send("Forbidden");
    }
  };
}
