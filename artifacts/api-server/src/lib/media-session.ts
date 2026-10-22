import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  db,
  callMediaSessionsTable,
  callLogsTable,
  tenantsTable,
  agentConfigsTable,
} from "@workspace/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import twilio from "twilio";
import { twilioAuthTokenFor } from "./tenant-credentials";

export class MediaAuthorizationError extends Error {
  constructor() {
    super("Media access denied");
  }
}
export type MediaSession = typeof callMediaSessionsTable.$inferSelect;
export type MediaBinding = Pick<
  MediaSession,
  "callLogId" | "tenantId" | "ownerId" | "provider" | "accountSid" | "callSid"
>;
export interface MediaSessionStore {
  binding(callId: number): Promise<MediaBinding | null>;
  get(callId: number): Promise<MediaSession | undefined>;
  insert(session: MediaSession): Promise<void>;
  claim(session: MediaSession, streamSid: string, now: Date): Promise<boolean>;
  close(id: string): Promise<boolean>;
}

export function createPostgresMediaSessionStore(
  connection: typeof db,
): MediaSessionStore {
  const db = connection;
  return {
    async binding(callId) {
      const call = await db.query.callLogsTable.findFirst({
        where: eq(callLogsTable.id, callId),
      });
      if (!call || call.endedAt || !call.callSid) return null;
      const tenants = await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.ownerId, call.userId))
        .limit(2);
      if (
        tenants.length !== 1 ||
        tenants[0].status !== "active" ||
        tenants[0].telephonyType === "EXOTEL" ||
        tenants[0].telephonyType === "VOBIZ_SIP"
      )
        return null;
      const agent = await db.query.agentConfigsTable.findFirst({
        where: eq(agentConfigsTable.userId, call.userId),
      });
      if (!agent?.twilioAccountSid || !agent.twilioAuthToken) return null;
      return {
        callLogId: call.id,
        ownerId: call.userId,
        tenantId: tenants[0].id,
        provider: "twilio",
        accountSid: agent.twilioAccountSid,
        callSid: call.callSid,
      };
    },
    get: (callId) =>
      db.query.callMediaSessionsTable.findFirst({
        where: eq(callMediaSessionsTable.callLogId, callId),
      }),
    async insert(session) {
      await db
        .insert(callMediaSessionsTable)
        .values(session)
        .onConflictDoNothing({ target: callMediaSessionsTable.callLogId });
    },
    async claim(session, streamSid, now) {
      // Recheck authoritative bindings in the SAME statement as the one-time claim.
      const rows = await db
        .update(callMediaSessionsTable)
        .set({ state: "active", streamSid, claimedAt: now })
        .where(
          and(
            eq(callMediaSessionsTable.id, session.id),
            eq(callMediaSessionsTable.state, "pending"),
            eq(callMediaSessionsTable.credentialHash, session.credentialHash),
            gt(callMediaSessionsTable.expiresAt, now),
            sql`exists (select 1 from ${callLogsTable} c join ${tenantsTable} t on t.id = ${session.tenantId}
        join ${agentConfigsTable} a on a.user_id = c.user_id
        where c.id = ${session.callLogId} and c.user_id = ${session.ownerId} and c.call_sid = ${session.callSid}
        and c.ended_at is null and t.owner_id = c.user_id and t.status = 'active' and t.telephony_type not in ('EXOTEL', 'VOBIZ_SIP')
        and a.twilio_account_sid = ${session.accountSid}
        and (select count(*) from ${tenantsTable} own where own.owner_id = c.user_id) = 1)`,
          ),
        )
        .returning({ id: callMediaSessionsTable.id });
      return rows.length === 1;
    },
    async close(id) {
      const rows = await db
        .update(callMediaSessionsTable)
        .set({ state: "closed", closedAt: new Date() })
        .where(
          and(
            eq(callMediaSessionsTable.id, id),
            eq(callMediaSessionsTable.state, "active"),
          ),
        )
        .returning({ id: callMediaSessionsTable.id });
      return rows.length === 1;
    },
  };
}
export const mediaSessionStore = createPostgresMediaSessionStore(db);

export function mediaPublicUrl(path: string, websocket = false): string {
  const raw = process.env.PUBLIC_BASE_URL;
  if (!raw) throw new MediaAuthorizationError();
  const base = new URL(raw);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new MediaAuthorizationError();
  if (websocket) base.protocol = "wss:";
  return `${base.origin}${path}`;
}

export function signingKey(): Buffer {
  const raw = process.env.MEDIA_SESSION_SIGNING_KEY || "";
  const key = Buffer.from(raw, "base64");
  if (key.length < 32 || key.toString("base64") !== raw)
    throw new MediaAuthorizationError();
  return key;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const matches = (left: string, right: string) =>
  left.length === right.length &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right));
const bindingFields = [
  "callLogId",
  "tenantId",
  "ownerId",
  "provider",
  "accountSid",
  "callSid",
] as const;
const sameBinding = (a: MediaBinding, b: MediaBinding) =>
  bindingFields.every((key) => a[key] === b[key]);

export function createMediaSessions(
  store: MediaSessionStore = mediaSessionStore,
  now = () => new Date(),
) {
  const credential = (session: MediaSession) =>
    `${session.id}.${createHmac("sha256", signingKey())
      .update(
        JSON.stringify([
          "dialog-media-v1",
          session.id,
          ...bindingFields.map((key) => session[key]),
          session.expiresAt.toISOString(),
        ]),
      )
      .digest("base64url")}`;
  return {
    async issue(callId: number) {
      signingKey(); // Validate before making persistent changes.
      const binding = await store.binding(callId);
      if (!binding) throw new MediaAuthorizationError();
      let session = await store.get(callId);
      if (!session) {
        session = {
          ...binding,
          id: randomUUID(),
          credentialHash: "",
          expiresAt: new Date(now().getTime() + 120_000),
          state: "pending",
          streamSid: null,
          createdAt: now(),
          claimedAt: null,
          closedAt: null,
        };
        session.credentialHash = hash(credential(session));
        await store.insert(session);
        session = await store.get(callId); // Concurrent issuers use the winning row.
      }
      if (
        !session ||
        session.state !== "pending" ||
        session.expiresAt <= now() ||
        !sameBinding(binding, session)
      )
        throw new MediaAuthorizationError();
      const token = credential(session);
      if (!matches(hash(token), session.credentialHash))
        throw new MediaAuthorizationError();
      return token;
    },
    async authenticate(callId: number, start: any) {
      const token = start?.customParameters?.mediaCredential;
      if (
        typeof token !== "string" ||
        token.length > 256 ||
        typeof start?.streamSid !== "string" ||
        !/^MZ[a-fA-F0-9]{32}$/.test(start.streamSid)
      )
        throw new MediaAuthorizationError();
      const session = await store.get(callId);
      if (
        !session ||
        session.state !== "pending" ||
        session.expiresAt <= now() ||
        !matches(hash(token), session.credentialHash) ||
        !matches(token, credential(session)) ||
        session.provider !== "twilio" ||
        start.accountSid !== session.accountSid ||
        start.callSid !== session.callSid
      )
        throw new MediaAuthorizationError();
      const binding = await store.binding(callId);
      if (
        !binding ||
        !sameBinding(binding, session) ||
        !(await store.claim(session, start.streamSid, now()))
      )
        throw new MediaAuthorizationError();
      return Object.freeze({
        ...session,
        streamSid: start.streamSid,
        state: "active" as const,
      });
    },
    close: (id: string) => store.close(id),
  };
}
export const mediaSessions = createMediaSessions();

export async function verifyTwilioUpgrade(
  callId: number,
  path: string,
  signature: unknown,
): Promise<void> {
  if (typeof signature !== "string" || !signature) throw new MediaAuthorizationError();
  const binding = await mediaSessionStore.binding(callId);
  if (!binding) throw new MediaAuthorizationError();
  const agent = await db.query.agentConfigsTable.findFirst({
    where: eq(agentConfigsTable.userId, binding.ownerId),
  });
  const authToken = agent ? twilioAuthTokenFor(agent) : null;
  if (
    !authToken ||
    !twilio.validateRequest(
      authToken,
      signature,
      mediaPublicUrl(path, true),
      {},
    )
  )
    throw new MediaAuthorizationError();
}

// Only the verified provider callback or its matching REST result may bind a SID.
export async function bindTwilioCallSid(
  callId: number,
  callSid: string,
): Promise<void> {
  if (!/^CA[a-fA-F0-9]{32}$/.test(callSid)) throw new MediaAuthorizationError();
  await db
    .update(callLogsTable)
    .set({ callSid })
    .where(
      and(
        eq(callLogsTable.id, callId),
        isNull(callLogsTable.callSid),
        isNull(callLogsTable.endedAt),
      ),
    );
  const call = await db.query.callLogsTable.findFirst({
    where: eq(callLogsTable.id, callId),
  });
  if (!call || call.endedAt || call.callSid !== callSid)
    throw new MediaAuthorizationError();
}
