import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  db as defaultDb,
  tenantsTable,
  widgetVerificationChallengesTable as challenges,
  widgetCustomerSessionsTable as sessions,
  type WidgetVerificationChallenge,
  type WidgetCustomerSession,
} from "@workspace/db";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { logger } from "./logger";
import { fetchCrmCustomerWithOrders, normalizeOrderId, normalizePhoneNumber } from "./widget-crm-orders";
import {
  matchOrdersBySuffix,
  normalizeCrmDob,
  normalizeSubmittedDigits,
  normalizeSubmittedDob,
  resolveTrustedField,
  suffixLengthFor,
  type DobFormat,
  type VerificationMethod,
} from "./widget-verification-factors";

export const CODE_TTL_MS = 5 * 60_000;
export const CHALLENGE_MAX_LIFETIME_MS = 20 * 60_000;
export const SESSION_TTL_MS = 30 * 60_000;
export const MAX_ATTEMPTS = 5;
export const MAX_RESENDS = 3;
export const RESEND_INTERVAL_MS = 60_000;
export const LIMITS = {
  destinationShort: { max: 3, windowMs: 15 * 60_000 },
  destinationDaily: { max: 10, windowMs: 24 * 60 * 60_000 },
  // Failed + successful factor submissions per phone across all challenges.
  destinationAttemptsDaily: { max: 15, windowMs: 24 * 60 * 60_000 },
  source: { max: 10, windowMs: 15 * 60_000 },
  tenant: { max: 200, windowMs: 60 * 60_000 },
} as const;
const RETENTION_MS = 25 * 60 * 60_000;
const CLEANUP_INTERVAL_MS = 10 * 60_000;
const ADVISORY_LOCK_NAMESPACE = 0x57564331; // "WVC1"

export interface VerificationCodeMessage {
  tenantId: number;
  ownerId: number;
  agentConfigId: number;
  phone: string;
  code: string;
}

/**
 * Delivers a one-time code to the customer's phone. The repository has no
 * approved OTP channel, so production runs with no sender and the
 * "sms_otp" policy method cannot be enabled.
 */
export interface VerificationCodeSender {
  send(message: VerificationCodeMessage): Promise<void>;
}

export interface WidgetAgent {
  id: number;
  userId: number;
}

/** The tenant's enabled, supported policy, resolved server-side per request. */
export interface ActiveVerificationPolicy {
  tenantId: number;
  version: number;
  method: VerificationMethod;
  dobFieldPath: string | null;
  dobFormat: DobFormat | null;
}

export type CustomerLookup = typeof fetchCrmCustomerWithOrders;

export type StartResult =
  | { ok: true; challengeId: string; method: VerificationMethod }
  | { ok: false; reason: "unavailable" | "invalid" | "rate_limited" };
export type VerifyResult =
  | { ok: true; token: string; sessionId: string; activeOrderId: string | null }
  | { ok: false };
export type ResendResult = { ok: true } | { ok: false; reason: "rate_limited" | "invalid" };

export class WidgetVerificationUnavailable extends Error {
  constructor() {
    super("Widget verification unavailable");
  }
}

export function verificationKey(): Buffer {
  const raw = process.env.WIDGET_VERIFICATION_KEY || "";
  const key = Buffer.from(raw, "base64");
  if (key.length < 32 || key.toString("base64") !== raw)
    throw new WidgetVerificationUnavailable();
  return key;
}

export function verificationKeyConfigured(): boolean {
  try {
    verificationKey();
    return true;
  } catch {
    return false;
  }
}

const keyed = (label: string, value: string) =>
  createHmac("sha256", verificationKey())
    .update(`dialog-widget-verification-v1:${label}:${value}`)
    .digest("hex");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sameHex = (left: string, right: string) =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^\d{6}$/;

export function isValidWidgetPhone(phone: unknown): phone is string {
  return typeof phone === "string" && phone.length <= 32 && /^\d{10}$/.test(normalizePhoneNumber(phone));
}

export interface WidgetVerificationOptions {
  db?: typeof defaultDb;
  sender?: VerificationCodeSender | null;
  isEligible?: (ownerId: number, phone: string) => Promise<boolean>;
  lookupCustomer?: CustomerLookup;
  now?: () => Date;
  schedule?: (task: () => Promise<void>) => void;
}

export function createWidgetVerification(options: WidgetVerificationOptions = {}) {
  const db = options.db ?? defaultDb;
  const sender = options.sender ?? null;
  const lookupCustomer = options.lookupCustomer ?? fetchCrmCustomerWithOrders;
  const isEligible =
    options.isEligible ??
    (async (ownerId: number, phone: string) => {
      const customer = await lookupCustomer(ownerId, phone);
      return customer.found && customer.orders.length > 0;
    });
  const now = options.now ?? (() => new Date());
  const schedule =
    options.schedule ??
    ((task: () => Promise<void>) => {
      setImmediate(() => void task());
    });
  let lastCleanup = 0;

  async function binding(agent: WidgetAgent, apiKey: string) {
    const owned = await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.ownerId, agent.userId))
      .limit(2);
    if (owned.length !== 1 || owned[0].status !== "active") return null;
    return {
      tenantId: owned[0].id as number,
      ownerId: agent.userId,
      agentConfigId: agent.id,
      widgetKeyHash: keyed("widget-key", apiKey),
    };
  }
  type Binding = NonNullable<Awaited<ReturnType<typeof binding>>>;
  const bound = (row: Binding, b: Binding) =>
    row.tenantId === b.tenantId &&
    row.ownerId === b.ownerId &&
    row.agentConfigId === b.agentConfigId &&
    sameHex(row.widgetKeyHash, b.widgetKeyHash);
  const underPolicy = (
    row: { tenantId: number; method: string; policyVersion: number },
    policy: ActiveVerificationPolicy,
  ) => row.tenantId === policy.tenantId && row.method === policy.method && row.policyVersion === policy.version;

  async function recent(tx: any, ...conditions: any[]): Promise<Array<{ attempts: number }>> {
    return tx
      .select({ id: challenges.id, attempts: challenges.attempts })
      .from(challenges)
      .where(and(...conditions));
  }

  function deliver(challenge: Pick<WidgetVerificationChallenge, "id" | "tenantId" | "ownerId" | "agentConfigId" | "phone">, code: string) {
    schedule(async () => {
      try {
        const eligible = await isEligible(challenge.ownerId, challenge.phone);
        await db
          .update(challenges)
          .set({ eligible })
          .where(eq(challenges.id, challenge.id));
        if (!eligible || !sender) return;
        await sender.send({
          tenantId: challenge.tenantId,
          ownerId: challenge.ownerId,
          agentConfigId: challenge.agentConfigId,
          phone: challenge.phone,
          code,
        });
        await db
          .update(challenges)
          .set({ lastSentAt: now() })
          .where(eq(challenges.id, challenge.id));
        logger.info({ event: "widget_verification_code_sent", challengeId: challenge.id }, "Widget verification code dispatched");
      } catch (err) {
        logger.error({ event: "widget_verification_delivery_failed", challengeId: challenge.id, err }, "Widget verification delivery failed");
      }
    });
  }

  async function cleanup() {
    const current = now();
    if (current.getTime() - lastCleanup < CLEANUP_INTERVAL_MS) return;
    lastCleanup = current.getTime();
    try {
      await db
        .delete(sessions)
        .where(lt(sessions.expiresAt, new Date(current.getTime() - 60 * 60_000)));
      await db
        .delete(challenges)
        .where(lt(challenges.createdAt, new Date(current.getTime() - RETENTION_MS)));
    } catch (err) {
      logger.warn({ event: "widget_verification_cleanup_failed", err }, "Widget verification cleanup failed");
    }
  }

  const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

  /**
   * Checks a knowledge factor against the tenant's own CRM record for the
   * challenge phone. Returns the uniquely matched order for suffix methods.
   */
  async function checkKnowledgeFactor(
    challenge: WidgetVerificationChallenge,
    policy: ActiveVerificationPolicy,
    factor: string,
  ): Promise<{ ok: true; orderId: string | null } | { ok: false; reason: string }> {
    const suffixLength = suffixLengthFor(policy.method);
    if (suffixLength) {
      const customer = await lookupCustomer(challenge.ownerId, challenge.phone);
      const matches = customer.found ? matchOrdersBySuffix(customer.orders, factor) : [];
      if (matches.length === 1) return { ok: true, orderId: normalizeOrderId(matches[0].orderId) };
      return { ok: false, reason: matches.length > 1 ? "ambiguous" : "mismatch" };
    }
    if (policy.method === "date_of_birth" && policy.dobFieldPath && policy.dobFormat) {
      const path = policy.dobFieldPath;
      const customer = await lookupCustomer(challenge.ownerId, challenge.phone, {
        readField: body => resolveTrustedField(body, path),
      });
      const reference = customer.found ? normalizeCrmDob(customer.field, policy.dobFormat) : null;
      if (!reference) return { ok: false, reason: customer.found ? "reference_unavailable" : "mismatch" };
      return sameHex(keyed("dob", reference), keyed("dob", factor))
        ? { ok: true, orderId: null }
        : { ok: false, reason: "mismatch" };
    }
    return { ok: false, reason: "unsupported" };
  }

  function otpAvailable() {
    return !!sender && verificationKeyConfigured();
  }

  return {
    /** True only when a code delivery provider and the server key are configured. */
    otpAvailable,
    /** Kept for Phase 1C callers; equivalent to otpAvailable(). */
    available: otpAvailable,

    async start(input: {
      agent: WidgetAgent;
      apiKey: string;
      phone: unknown;
      source: string;
      policy: ActiveVerificationPolicy;
    }): Promise<StartResult> {
      const { policy } = input;
      if (!verificationKeyConfigured()) return { ok: false, reason: "unavailable" };
      if (policy.method === "sms_otp" && !sender) return { ok: false, reason: "unavailable" };
      if (!isValidWidgetPhone(input.phone)) return { ok: false, reason: "invalid" };
      const phone = normalizePhoneNumber(input.phone);
      const b = await binding(input.agent, input.apiKey);
      if (!b || b.tenantId !== policy.tenantId) return { ok: false, reason: "unavailable" };
      void cleanup();
      const current = now();
      const destinationHash = keyed("destination", `${b.tenantId}:${phone}`);
      const sourceHash = keyed("source", input.source || "unknown");
      const since = (windowMs: number) => new Date(current.getTime() - windowMs);
      const isOtp = policy.method === "sms_otp";
      const code = isOtp ? newCode() : null;
      const id = randomUUID();
      const created = await db.transaction(async (tx: any) => {
        // Serializes limit checks per tenant so concurrent starts cannot overrun them.
        await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE}, ${b.tenantId})`);
        const destination = eq(challenges.destinationHash, destinationHash);
        const tenant = eq(challenges.tenantId, b.tenantId);
        const short = await recent(tx, tenant, destination, gt(challenges.createdAt, since(LIMITS.destinationShort.windowMs)));
        const daily = await recent(tx, tenant, destination, gt(challenges.createdAt, since(LIMITS.destinationDaily.windowMs)));
        const fromSource = await recent(tx, tenant, eq(challenges.sourceHash, sourceHash), gt(challenges.createdAt, since(LIMITS.source.windowMs)));
        const tenantWide = await recent(tx, tenant, gt(challenges.createdAt, since(LIMITS.tenant.windowMs)));
        const dailyAttempts = daily.reduce((sum, row) => sum + row.attempts, 0);
        if (
          short.length >= LIMITS.destinationShort.max ||
          daily.length >= LIMITS.destinationDaily.max ||
          dailyAttempts >= LIMITS.destinationAttemptsDaily.max ||
          fromSource.length >= LIMITS.source.max ||
          tenantWide.length >= LIMITS.tenant.max
        )
          return null;
        const row = {
          id,
          ...b,
          phone,
          destinationHash,
          sourceHash,
          // Knowledge-factor challenges store an unguessable placeholder; the
          // code path is never evaluated for them.
          codeHash: keyed("code", `${id}:${code ?? randomBytes(32).toString("hex")}`),
          method: policy.method,
          policyVersion: policy.version,
          eligible: null,
          state: "pending",
          attempts: 0,
          resendCount: 0,
          lastSentAt: null,
          expiresAt: new Date(current.getTime() + CODE_TTL_MS),
          createdAt: current,
          verifiedAt: null,
        };
        await tx.insert(challenges).values(row);
        return row;
      });
      if (!created) {
        logger.warn({ event: "widget_verification_rate_limited", tenantId: b.tenantId }, "Widget verification start rate limited");
        return { ok: false, reason: "rate_limited" };
      }
      if (code) deliver(created, code);
      logger.info(
        { event: "widget_verification_started", tenantId: b.tenantId, challengeId: id, method: policy.method },
        "Widget verification challenge created",
      );
      return { ok: true, challengeId: id, method: policy.method };
    },

    async resend(input: {
      agent: WidgetAgent;
      apiKey: string;
      challengeId: unknown;
      policy: ActiveVerificationPolicy;
    }): Promise<ResendResult> {
      if (!otpAvailable() || input.policy.method !== "sms_otp") return { ok: false, reason: "invalid" };
      if (typeof input.challengeId !== "string" || !UUID.test(input.challengeId)) return { ok: false, reason: "invalid" };
      const b = await binding(input.agent, input.apiKey);
      if (!b) return { ok: false, reason: "invalid" };
      const challenge = await db.query.widgetVerificationChallengesTable.findFirst({
        where: eq(challenges.id, input.challengeId),
      });
      const current = now();
      if (
        !challenge ||
        !bound(challenge, b) ||
        !underPolicy(challenge, input.policy) ||
        challenge.state !== "pending" ||
        challenge.expiresAt <= current
      )
        return { ok: false, reason: "invalid" };
      const lastIssued = (challenge.lastSentAt ?? challenge.createdAt).getTime();
      if (challenge.resendCount >= MAX_RESENDS || current.getTime() - lastIssued < RESEND_INTERVAL_MS)
        return { ok: false, reason: "rate_limited" };
      const code = newCode();
      const updated = await db
        .update(challenges)
        .set({
          codeHash: keyed("code", `${challenge.id}:${code}`),
          resendCount: challenge.resendCount + 1,
          lastSentAt: current,
          expiresAt: new Date(
            Math.min(current.getTime() + CODE_TTL_MS, challenge.createdAt.getTime() + CHALLENGE_MAX_LIFETIME_MS),
          ),
        })
        .where(
          and(
            eq(challenges.id, challenge.id),
            eq(challenges.state, "pending"),
            eq(challenges.resendCount, challenge.resendCount),
          ),
        )
        .returning({ id: challenges.id });
      if (updated.length !== 1) return { ok: false, reason: "rate_limited" };
      deliver(challenge, code);
      return { ok: true };
    },

    async verify(input: {
      agent: WidgetAgent;
      apiKey: string;
      challengeId: unknown;
      policy: ActiveVerificationPolicy;
      code?: unknown;
      orderDigits?: unknown;
      dateOfBirth?: unknown;
    }): Promise<VerifyResult> {
      const { policy } = input;
      const fail = (reason: string, challengeId?: string): VerifyResult => {
        logger.warn({ event: "widget_verification_failed", reason, challengeId, method: policy.method }, "Widget verification failed");
        return { ok: false };
      };
      if (!verificationKeyConfigured()) return fail("unavailable");
      if (policy.method === "sms_otp" && !sender) return fail("unavailable");
      if (typeof input.challengeId !== "string" || !UUID.test(input.challengeId)) return fail("malformed");
      const suffixLength = suffixLengthFor(policy.method);
      const factor =
        policy.method === "sms_otp"
          ? typeof input.code === "string" && CODE.test(input.code) ? input.code : null
          : suffixLength
            ? normalizeSubmittedDigits(input.orderDigits, suffixLength)
            : normalizeSubmittedDob(input.dateOfBirth);
      if (!factor) return fail("malformed", input.challengeId);
      const b = await binding(input.agent, input.apiKey);
      if (!b) return fail("binding", input.challengeId);
      const challenge = await db.query.widgetVerificationChallengesTable.findFirst({
        where: eq(challenges.id, input.challengeId),
      });
      const current = now();
      if (!challenge || !bound(challenge, b)) return fail("unknown", input.challengeId);
      if (!underPolicy(challenge, policy)) return fail("policy_changed", challenge.id);
      if (challenge.state !== "pending" || challenge.expiresAt <= current || challenge.attempts >= MAX_ATTEMPTS)
        return fail("inactive", challenge.id);
      // Optimistic increment: concurrent attempts against the same count lose.
      const counted = await db
        .update(challenges)
        .set({ attempts: challenge.attempts + 1 })
        .where(
          and(
            eq(challenges.id, challenge.id),
            eq(challenges.state, "pending"),
            eq(challenges.attempts, challenge.attempts),
            gt(challenges.expiresAt, current),
          ),
        )
        .returning({ id: challenges.id });
      if (counted.length !== 1) return fail("concurrent", challenge.id);

      let outcome: { ok: true; orderId: string | null } | { ok: false; reason: string };
      if (policy.method === "sms_otp") {
        const correct = sameHex(keyed("code", `${challenge.id}:${factor}`), challenge.codeHash);
        outcome = correct && challenge.eligible === true
          ? { ok: true, orderId: null }
          : { ok: false, reason: correct ? "ineligible" : "mismatch" };
      } else {
        try {
          outcome = await checkKnowledgeFactor(challenge, policy, factor);
        } catch (err) {
          logger.error({ event: "widget_verification_lookup_failed", challengeId: challenge.id, err }, "Widget verification CRM lookup failed");
          outcome = { ok: false, reason: "lookup_failed" };
        }
      }
      if (!outcome.ok) {
        if (challenge.attempts + 1 >= MAX_ATTEMPTS)
          await db
            .update(challenges)
            .set({ state: "failed" })
            .where(and(eq(challenges.id, challenge.id), eq(challenges.state, "pending")));
        return fail(outcome.reason, challenge.id);
      }
      const consumed = await db
        .update(challenges)
        .set({ state: "verified", verifiedAt: current })
        .where(and(eq(challenges.id, challenge.id), eq(challenges.state, "pending")))
        .returning({ id: challenges.id });
      if (consumed.length !== 1) return fail("consumed", challenge.id);
      const token = randomBytes(32).toString("base64url");
      const sessionId = randomUUID();
      await db.insert(sessions).values({
        id: sessionId,
        tokenHash: sha256(token),
        challengeId: challenge.id,
        ...b,
        phone: challenge.phone,
        method: policy.method,
        policyVersion: policy.version,
        scope: outcome.orderId ? "order" : "customer",
        activeOrderId: outcome.orderId,
        state: "active",
        expiresAt: new Date(current.getTime() + SESSION_TTL_MS),
        createdAt: current,
        lastUsedAt: null,
        revokedAt: null,
      });
      logger.info(
        { event: "widget_verification_verified", challengeId: challenge.id, sessionId, method: policy.method },
        "Widget customer verified",
      );
      return { ok: true, token, sessionId, activeOrderId: outcome.orderId };
    },

    /**
     * Validates an opaque session token against the widget in use and the
     * tenant's current policy. A null policy (disabled or unsupported) or any
     * policy change since issuance rejects the session.
     */
    async authorize(
      token: unknown,
      agent: WidgetAgent,
      apiKey: string,
      policy: ActiveVerificationPolicy | null,
    ): Promise<WidgetCustomerSession | null> {
      if (!policy || typeof token !== "string" || !TOKEN.test(token)) return null;
      if (!verificationKeyConfigured()) return null;
      const session = await db.query.widgetCustomerSessionsTable.findFirst({
        where: eq(sessions.tokenHash, sha256(token)),
      });
      const current = now();
      if (!session || session.state !== "active" || session.revokedAt || session.expiresAt <= current) return null;
      if (!underPolicy(session, policy)) return null;
      const b = await binding(agent, apiKey);
      if (!b || !bound(session, b)) return null;
      await db
        .update(sessions)
        .set({ lastUsedAt: current })
        .where(eq(sessions.id, session.id));
      return session;
    },

    /** Order-scoped sessions can never move to a different order. */
    async setActiveOrder(session: WidgetCustomerSession, orderId: string): Promise<boolean> {
      if (session.scope === "order" && orderId !== session.activeOrderId) return false;
      const updated = await db
        .update(sessions)
        .set({ activeOrderId: orderId })
        .where(and(eq(sessions.id, session.id), eq(sessions.state, "active")))
        .returning({ id: sessions.id });
      return updated.length === 1;
    },

    async revoke(session: WidgetCustomerSession): Promise<void> {
      await db
        .update(sessions)
        .set({ state: "revoked", revokedAt: now() })
        .where(and(eq(sessions.id, session.id), eq(sessions.state, "active")));
      logger.info({ event: "widget_session_revoked", sessionId: session.id }, "Widget customer session revoked");
    },

    /** Revokes every active session and closes pending challenges for a tenant. */
    async invalidateTenant(tenantId: number): Promise<void> {
      const current = now();
      await db
        .update(sessions)
        .set({ state: "revoked", revokedAt: current })
        .where(and(eq(sessions.tenantId, tenantId), eq(sessions.state, "active")));
      await db
        .update(challenges)
        .set({ state: "failed" })
        .where(and(eq(challenges.tenantId, tenantId), eq(challenges.state, "pending")));
      logger.info({ event: "widget_verification_tenant_invalidated", tenantId }, "Widget verification state invalidated for tenant");
    },
  };
}

export type WidgetVerification = ReturnType<typeof createWidgetVerification>;

let service: WidgetVerification = createWidgetVerification();
export const getWidgetVerification = () => service;
/** Replaces the process-wide service; used to inject a delivery provider. */
export function setWidgetVerification(next: WidgetVerification) {
  service = next;
}
