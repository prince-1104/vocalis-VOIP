/**
 * Log-only redaction. These helpers build new values for diagnostic output and
 * never mutate their input; business data sent to providers, stored in the
 * database or returned to authorized clients must not pass through them.
 */

export const REDACTED = "[REDACTED]";

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_CHARS = 1000;
const MAX_STACK_FRAMES = 20;
const MAX_ERROR_DEPTH = 3;
const MAX_AGGREGATE_ERRORS = 5;

const normalizeKey = (key: string) => key.toLowerCase().replace(/[_\-\s.]/g, "");

/** Always kept even if they would otherwise match a sensitive name. */
const STRUCTURAL_KEYS = new Set([
  "msg",
  "event",
  "eventtype",
  "provider",
  "code",
  "type",
  "level",
  "time",
  "status",
  "statuscode",
]);

/** Credential-bearing names; matched as substrings of the normalized key. */
const SECRET_KEY_PARTS = [
  "password",
  "sipusername",
  "passwd",
  "secret",
  "token",
  "apikey",
  "authorization",
  "authvalue",
  "cookie",
  "credential",
  "signature",
  "privatekey",
  "connectionstring",
  "databaseurl",
  "jwt",
];

/** Customer/business content names, matched exactly on the normalized key. */
const CUSTOMER_KEYS = new Set([
  "phone",
  "phonenumber",
  "to",
  "from",
  "caller",
  "callerid",
  "calleridentity",
  "callernumber",
  "customerphone",
  "customernumber",
  "mobile",
  "email",
  "emailaddress",
  "name",
  "customername",
  "firstname",
  "lastname",
  "fullname",
  "transcript",
  "rawtranscript",
  "livetranscript",
  "utterance",
  "message",
  "messages",
  "text",
  "prompt",
  "systemprompt",
  "sentence",
  "greeting",
  "content",
  "body",
  "payload",
  "data",
  "rawdata",
  "address",
  "orderid",
  "orderids",
  "recentorders",
  "audio",
  "media",
  "digit",
  "digits",
  "dtmf",
  "rawdtmf",
  "destination",
  "transferto",
  "targetphone",
  "identity",
  "history",
  "summary",
  "query",
  "params",
  "detail",
  "reply",
  "response",
  "responsebody",
  "request",
  "requestbody",
  "context",
  "headers",
  "config",
]);

/** Customer content names matched as substrings when the value is not numeric. */
const CUSTOMER_KEY_PARTS = ["phone", "email", "transcript", "utterance"];

type KeyClass = "secret" | "customer" | null;

function classifyKey(key: string, value: unknown): KeyClass {
  const k = normalizeKey(key);
  if (STRUCTURAL_KEYS.has(k)) return null;
  // Counters such as promptTokens or transcriptLength stay useful.
  if (typeof value === "number" || typeof value === "boolean") {
    return CUSTOMER_KEYS.has(k) && typeof value === "number" ? "customer" : null;
  }
  if (SECRET_KEY_PARTS.some((part) => k.includes(part))) return "secret";
  if (CUSTOMER_KEYS.has(k)) return "customer";
  if (CUSTOMER_KEY_PARTS.some((part) => k.includes(part))) return "customer";
  return null;
}

// ── Free-text scrubbing ──────────────────────────────────────────────────

const TEXT_RULES: Array<[RegExp, string]> = [
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s'"<>]+/gi, "[REDACTED_URI]"],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"<>]+:[^\s/@'"<>]+@/gi, `$1${REDACTED}@`],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[REDACTED_JWT]"],
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}/g, "[REDACTED_KEY]"],
  [
    /([?&;](?:[^=&\s#]*?)(?:token|key|secret|signature|sig|password|passwd|pwd|credential|auth|session|phone|mobile|email|caller|to|from)(?:[^=&\s#]*)=)[^&\s#'"<>]*/gi,
    `$1${REDACTED}`,
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
  [/(?<![\w.-])\+?\d(?:[\s().-]{0,2}\d){9,14}(?![\w-])/g, "[REDACTED_PHONE]"],
];

function truncate(text: string, max = MAX_STRING_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text;
}

/** Scrub recognizable phones, emails and secret-bearing values from free text. */
export function scrubText(input: unknown): string {
  try {
    let text = truncate(typeof input === "string" ? input : String(input), MAX_STRING_CHARS * 4);
    for (const [pattern, replacement] of TEXT_RULES) text = text.replace(pattern, replacement);
    return truncate(text);
  } catch {
    return "[Unserializable]";
  }
}

/** Origin and path only; query, fragment and credentials are dropped. */
export function safeUrl(url: unknown): string {
  try {
    const parsed = new URL(String(url));
    return scrubText(`${parsed.origin}${parsed.pathname}`);
  } catch {
    return "[INVALID_URL]";
  }
}

// ── Errors ───────────────────────────────────────────────────────────────

/** Error for failed provider HTTP calls that never carries the response body. */
export class ProviderHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly providerCode?: string;

  constructor(provider: string, status: number, providerCode?: string) {
    super(`${provider} API error ${status}`);
    this.name = "ProviderHttpError";
    this.provider = provider;
    this.status = status;
    this.providerCode = providerCode;
  }
}

/** Extract only a short machine-readable code from a provider error body. */
export function extractProviderCode(rawBody: unknown): string | undefined {
  try {
    if (typeof rawBody !== "string" || rawBody.length > 100_000) return undefined;
    const parsed = JSON.parse(rawBody);
    const candidate =
      parsed?.code ?? parsed?.error?.code ?? parsed?.error?.type ?? parsed?.RestException?.Code;
    if (typeof candidate !== "string" && typeof candidate !== "number") return undefined;
    const code = String(candidate);
    return /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

export function providerHttpError(provider: string, status: number, rawBody?: unknown): ProviderHttpError {
  return new ProviderHttpError(provider, status, extractProviderCode(rawBody));
}

const HTTP_BODY_FIELDS = ["headers", "error", "response", "request", "config", "body"];

function safeErrorMessage(message: unknown): string {
  if (message === undefined || message === null) return "";
  let text = typeof message === "string" ? message : String(message);
  // Drizzle query errors embed SQL text and bound parameter values.
  if (/^\s*Failed query/i.test(text)) return "Failed query (details omitted)";
  text = text.replace(/\n?\s*params:[\s\S]*$/i, " (params omitted)");
  return scrubText(text);
}

function safeStack(stack: unknown, header: string): string | undefined {
  if (typeof stack !== "string") return undefined;
  const frames = stack
    .split("\n")
    .filter((line) => /^\s+at\s/.test(line))
    .slice(0, MAX_STACK_FRAMES)
    .map((line) => scrubText(line));
  return [header, ...frames].join("\n");
}

function readField(source: any, key: string): unknown {
  try {
    return source?.[key];
  } catch {
    return undefined;
  }
}

/**
 * Allowlist serializer for errors (and error-shaped plain objects). Request,
 * response, header, body, config and query details are never copied.
 */
export function safeError(err: unknown, depth = 0): unknown {
  try {
    if (err === null || err === undefined) return err;
    if (typeof err !== "object" && typeof err !== "function") {
      return { message: safeErrorMessage(err) };
    }
    const typeName = readField(err, "name") ?? readField(err, "type");
    const type = typeof typeName === "string" ? truncate(typeName, 64) : "Error";
    const out: Record<string, unknown> = { type };

    const code = readField(err, "code");
    if (typeof code === "string" || typeof code === "number") out.code = truncate(String(code), 64);
    for (const key of ["status", "statusCode", "errno"]) {
      const value = readField(err, key);
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    const httpStatus = (out.status ?? out.statusCode) as number | undefined;
    const rawMessage = readField(err, "message");
    // HTTP client/SDK and body-parser errors derive their message from
    // remote or request bodies, which may echo customer content.
    const carriesBody = HTTP_BODY_FIELDS.some((key) => readField(err, key) !== undefined);
    const message =
      httpStatus !== undefined && carriesBody
        ? `HTTP ${httpStatus} error (message omitted)`
        : type === "SyntaxError" && /JSON/i.test(String(rawMessage))
          ? "Invalid JSON (details omitted)"
          : safeErrorMessage(rawMessage);
    out.message = message;
    for (const key of ["syscall", "constraint", "provider", "providerCode"]) {
      const value = readField(err, key);
      if (typeof value === "string") out[key] = scrubText(truncate(value, 128));
    }
    const stack = safeStack(readField(err, "stack"), `${type}: ${message}`);
    if (stack) out.stack = stack;

    if (depth < MAX_ERROR_DEPTH) {
      const cause = readField(err, "cause");
      if (cause !== undefined) out.cause = safeError(cause, depth + 1);
      const errors = readField(err, "errors");
      if (Array.isArray(errors)) {
        out.errors = errors.slice(0, MAX_AGGREGATE_ERRORS).map((e) => safeError(e, depth + 1));
      }
    }
    return out;
  } catch {
    return { type: "Error", message: "[Unserializable error]" };
  }
}

// ── Structured redaction ─────────────────────────────────────────────────

function isErrorLike(value: object): boolean {
  return value instanceof Error;
}

function isBinary(value: object): number | null {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.length;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return null;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  switch (typeof value) {
    case "string":
      return scrubText(value);
    case "number":
    case "boolean":
    case "undefined":
      return value;
    case "bigint":
      return value.toString();
    case "symbol":
      return "[Symbol]";
    case "function":
      return "[Function]";
  }
  if (value === null) return null;
  const obj = value as object;
  if (seen.has(obj)) return "[Circular]";
  if (isErrorLike(obj)) return safeError(obj);
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "[Invalid Date]" : obj.toISOString();
  const bytes = isBinary(obj);
  if (bytes !== null) return `[Binary ${bytes} bytes]`;
  if (obj instanceof Map) return `[Map size=${obj.size}]`;
  if (obj instanceof Set) return `[Set size=${obj.size}]`;
  if (depth >= MAX_DEPTH) return "[Truncated]";

  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const out = obj.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1, seen));
      if (obj.length > MAX_ARRAY_ITEMS) out.push(`[${obj.length - MAX_ARRAY_ITEMS} more items]`);
      return out;
    }
    const out: Record<string, unknown> = {};
    const keys = Object.keys(obj);
    for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
      let child: unknown;
      try {
        child = (obj as Record<string, unknown>)[key];
      } catch {
        out[key] = "[Unreadable]";
        continue;
      }
      const cls = classifyKey(key, child);
      if (cls) {
        out[key] = child === null || child === undefined ? child : REDACTED;
        continue;
      }
      try {
        out[key] = redactValue(child, depth + 1, seen);
      } catch {
        out[key] = "[Unserializable]";
      }
    }
    if (keys.length > MAX_OBJECT_KEYS) out._truncatedKeys = keys.length - MAX_OBJECT_KEYS;
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Recursively copy a value for logging, redacting credential and customer
 * fields by name and scrubbing free text. Never returns the original object.
 */
export function redactForLog(value: unknown): unknown {
  try {
    return redactValue(value, 0, new WeakSet());
  } catch {
    return "[Unserializable]";
  }
}
