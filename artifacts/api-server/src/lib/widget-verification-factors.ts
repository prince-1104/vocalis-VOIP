import { normalizeOrderId, type CrmOrder } from "./widget-crm-orders";

export const VERIFICATION_METHODS = ["order_suffix_4", "order_suffix_6", "date_of_birth", "sms_otp"] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];
export const DEFAULT_VERIFICATION_METHOD: VerificationMethod = "order_suffix_4";

export const DOB_FORMATS = ["YYYY-MM-DD", "DD-MM-YYYY", "DD/MM/YYYY", "MM/DD/YYYY"] as const;
export type DobFormat = (typeof DOB_FORMATS)[number];

export const isVerificationMethod = (value: unknown): value is VerificationMethod =>
  typeof value === "string" && (VERIFICATION_METHODS as readonly string[]).includes(value);
export const isDobFormat = (value: unknown): value is DobFormat =>
  typeof value === "string" && (DOB_FORMATS as readonly string[]).includes(value);

export function suffixLengthFor(method: VerificationMethod): 4 | 6 | null {
  if (method === "order_suffix_4") return 4;
  if (method === "order_suffix_6") return 6;
  return null;
}

const MAX_SUBMITTED_DIGITS = 20;

/**
 * Customer input for an order-digit factor. At least `length` digits; more
 * are accepted so a customer can disambiguate by typing the full numeric tail.
 */
export function normalizeSubmittedDigits(input: unknown, length: number): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const digits = input.trim().replace(/^#/, "").replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits) || digits.length < length || digits.length > MAX_SUBMITTED_DIGITS) return null;
  return digits;
}

/**
 * The trailing run of digits in a normalized order ID, kept as a string so
 * leading zeros stay significant ("ORD-000123" -> "000123").
 */
export function trailingOrderDigits(orderId: string): string {
  return /(\d+)$/.exec(normalizeOrderId(orderId))?.[1] ?? "";
}

/** Orders whose trailing digits end with `digits`, de-duplicated by order ID. */
export function matchOrdersBySuffix(orders: CrmOrder[], digits: string): CrmOrder[] {
  const matched = new Map<string, CrmOrder>();
  for (const order of orders) {
    const id = normalizeOrderId(order.orderId);
    const tail = trailingOrderDigits(id);
    if (tail.length >= digits.length && tail.endsWith(digits)) matched.set(id, order);
  }
  return [...matched.values()];
}

const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** Dot-separated property path into the CRM lookup response, e.g. "customer.dateOfBirth". */
export function isValidDobFieldPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 128) return false;
  const segments = path.split(".");
  return segments.length <= 6 && segments.every(s => PATH_SEGMENT.test(s) && !FORBIDDEN_SEGMENTS.has(s));
}

/** Resolves a validated path using own properties only. */
export function resolveTrustedField(body: unknown, path: string): unknown {
  if (!isValidDobFieldPath(path)) return undefined;
  let current: unknown = body;
  for (const segment of path.split(".")) {
    if (current == null || typeof current !== "object" || Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (date.getTime() > Date.now()) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Normalizes the CRM's reference date of birth to YYYY-MM-DD using the
 * tenant-configured format. Anything else (timestamps, numbers, objects,
 * alternative separators) is rejected so verification fails closed.
 */
export function normalizeCrmDob(value: unknown, format: DobFormat): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  let m: RegExpExecArray | null;
  switch (format) {
    case "YYYY-MM-DD":
      m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
      return m ? isoDate(+m[1], +m[2], +m[3]) : null;
    case "DD-MM-YYYY":
      m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text);
      return m ? isoDate(+m[3], +m[2], +m[1]) : null;
    case "DD/MM/YYYY":
      m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
      return m ? isoDate(+m[3], +m[2], +m[1]) : null;
    case "MM/DD/YYYY":
      m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
      return m ? isoDate(+m[3], +m[1], +m[2]) : null;
  }
}

/**
 * Customer-entered date of birth. The widget asks for DD/MM/YYYY; ISO
 * YYYY-MM-DD (from date pickers) and DD-MM-YYYY are also accepted. The
 * year position makes these unambiguous.
 */
export function normalizeSubmittedDob(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32) return null;
  const text = value.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return isoDate(+iso[1], +iso[2], +iso[3]);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (dmy) return isoDate(+dmy[3], +dmy[2], +dmy[1]);
  return null;
}
