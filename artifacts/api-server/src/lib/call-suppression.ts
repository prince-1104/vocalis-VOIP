import { db, callSuppressionsTable } from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";

type Connection = typeof db;

export type SuppressionReason = "opt_out" | "do_not_call";
export type SuppressionSource = "dashboard" | "crm_api";
export const SUPPRESSION_REASONS: readonly SuppressionReason[] = ["opt_out", "do_not_call"];

export type DialBlockCode = "suppressed" | "invalid_phone" | "suppression_unavailable";

/** Raised before any call log or provider request when a dial must not happen. */
export class DialBlockedError extends Error {
  constructor(readonly code: DialBlockCode) {
    super(
      code === "suppressed"
        ? "This number has opted out or is on the do-not-call list."
        : code === "invalid_phone"
          ? "The phone number is not valid."
          : "Do-not-call status could not be checked; the call was not placed.",
    );
    this.name = "DialBlockedError";
  }
}

export function dialBlockedHttpStatus(err: DialBlockedError): number {
  return err.code === "suppressed" ? 403 : err.code === "invalid_phone" ? 400 : 503;
}

export interface NormalizedPhone {
  /** E.164 when the country is known (+91 for bare 10-digit Indian mobiles), otherwise digits only. */
  phone: string;
  /** Suppression matching key: the last 10 digits. */
  key: string;
}

/**
 * Normalization for suppression matching. The project has no numbering
 * library; the rules mirror the existing Indian-number handling
 * (widget-crm-orders normalizePhoneNumber). Matching on the last 10 digits
 * deliberately errs toward suppressing: "+91 98…", "098…" and "98…" all match,
 * at the cost of rare cross-country collisions.
 */
export function normalizePhone(raw: unknown): NormalizedPhone | null {
  if (typeof raw !== "string") return null;
  const compact = raw.trim().replace(/^tel:/i, "").replace(/[\s().-]/g, "");
  let phone: string;
  if (/^\+\d{8,15}$/.test(compact)) phone = compact;
  else if (/^00\d{8,15}$/.test(compact)) phone = "+" + compact.slice(2);
  else if (/^[6-9]\d{9}$/.test(compact)) phone = "+91" + compact;
  else if (/^0[6-9]\d{9}$/.test(compact)) phone = "+91" + compact.slice(1);
  else if (/^91[6-9]\d{9}$/.test(compact)) phone = "+" + compact;
  else if (/^\d{8,15}$/.test(compact)) phone = compact;
  else return null;
  const digits = phone.replace(/\D/g, "");
  return { phone, key: digits.slice(-10) };
}

/**
 * Throws DialBlockedError unless the number may be dialed for this tenant.
 * Fails closed: an unreadable suppression store blocks the call.
 */
export async function assertDialAllowed(userId: number, rawPhone: string, connection: Connection = db): Promise<void> {
  const normalized = normalizePhone(rawPhone);
  if (!normalized) throw new DialBlockedError("invalid_phone");
  let active: unknown;
  try {
    active = await connection.query.callSuppressionsTable.findFirst({
      where: and(
        eq(callSuppressionsTable.userId, userId),
        eq(callSuppressionsTable.phoneKey, normalized.key),
        isNull(callSuppressionsTable.revokedAt),
      ),
    });
  } catch {
    throw new DialBlockedError("suppression_unavailable");
  }
  if (active) throw new DialBlockedError("suppressed");
}

/** Idempotent: repeated opt-outs for the same tenant and number keep one active record. */
export async function addSuppression(
  userId: number,
  rawPhone: unknown,
  reason: SuppressionReason,
  source: SuppressionSource,
  connection: Connection = db,
): Promise<{ id: number; phone: string; reason: string; created: boolean } | null> {
  const normalized = normalizePhone(rawPhone);
  if (!normalized) return null;
  const match = and(eq(callSuppressionsTable.userId, userId), eq(callSuppressionsTable.phoneKey, normalized.key));
  const [inserted] = await connection.insert(callSuppressionsTable)
    .values({ userId, phoneKey: normalized.key, phone: normalized.phone, reason, source })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { id: inserted.id, phone: inserted.phone, reason: inserted.reason, created: true };
  const existing = await connection.query.callSuppressionsTable.findFirst({ where: match });
  if (!existing) throw new Error("Suppression record missing after conflict");
  if (existing.revokedAt) {
    await connection.update(callSuppressionsTable)
      .set({ revokedAt: null, reason, source, updatedAt: new Date() })
      .where(and(eq(callSuppressionsTable.id, existing.id), eq(callSuppressionsTable.userId, userId)));
    return { id: existing.id, phone: existing.phone, reason, created: true };
  }
  return { id: existing.id, phone: existing.phone, reason: existing.reason, created: false };
}

/** Only the owning tenant can revoke; another tenant's id behaves as not found. */
export async function revokeSuppression(userId: number, id: number, connection: Connection = db): Promise<boolean> {
  const revoked = await connection.update(callSuppressionsTable)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(callSuppressionsTable.id, id),
      eq(callSuppressionsTable.userId, userId),
      isNull(callSuppressionsTable.revokedAt),
    ))
    .returning({ id: callSuppressionsTable.id });
  return revoked.length === 1;
}

export async function listSuppressions(userId: number, connection: Connection = db) {
  return connection.select({
    id: callSuppressionsTable.id,
    phone: callSuppressionsTable.phone,
    reason: callSuppressionsTable.reason,
    source: callSuppressionsTable.source,
    createdAt: callSuppressionsTable.createdAt,
    updatedAt: callSuppressionsTable.updatedAt,
  })
    .from(callSuppressionsTable)
    .where(and(eq(callSuppressionsTable.userId, userId), isNull(callSuppressionsTable.revokedAt)))
    .orderBy(desc(callSuppressionsTable.createdAt));
}
