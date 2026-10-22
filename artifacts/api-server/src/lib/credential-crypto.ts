import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Recoverable tenant credentials (provider tokens, CRM auth values, webhook
 * signing secrets) are stored as
 *
 *   enc:v1:<keyId>:<nonce>:<ciphertext>:<tag>      (base64url segments)
 *
 * v1 is AES-256-GCM with a random 96-bit nonce and a 128-bit tag. The
 * additional authenticated data binds the version, key id, column and owning
 * tenant/user, so a ciphertext copied to another column or tenant fails
 * authentication instead of decrypting.
 *
 * Keys come only from CREDENTIAL_ENCRYPTION_KEYS / _ACTIVE_KEY_ID; there is
 * no default and nothing is derived from JWT_SECRET. Legacy representations
 * are read-only: values are never written in any format but v1.
 */

export type CredentialField =
  | "twilioAuthToken"
  | "telephonyApiKey"
  | "telephonyApiSecret"
  | "crmAuthValue"
  | "crmWebhookSecret"
  | "sipPassword"
  | "exotelApiKey"
  | "exotelApiToken";

/**
 * `legacy` is the representation each column held before v1: plaintext
 * columns were never encrypted; cbc columns used the old AES-256-CBC helper.
 */
export const CREDENTIAL_FIELDS: Record<CredentialField, { column: string; legacy: "plaintext" | "cbc" }> = {
  twilioAuthToken: { column: "agent_configs.twilio_auth_token", legacy: "plaintext" },
  telephonyApiKey: { column: "agent_configs.telephony_api_key", legacy: "plaintext" },
  telephonyApiSecret: { column: "agent_configs.telephony_api_secret", legacy: "plaintext" },
  crmAuthValue: { column: "external_crm_configs.auth_value", legacy: "plaintext" },
  crmWebhookSecret: { column: "crm_api_keys.webhook_secret", legacy: "plaintext" },
  sipPassword: { column: "sip_trunk_configs.sip_password", legacy: "cbc" },
  exotelApiKey: { column: "exotel_configs.api_key", legacy: "cbc" },
  exotelApiToken: { column: "exotel_configs.api_token", legacy: "cbc" },
};

export type CredentialErrorReason =
  | "key_config"
  | "unknown_key"
  | "authentication"
  | "format"
  | "legacy_disabled"
  | "legacy_key_unavailable"
  | "legacy_decrypt";

/** Carries only a reason code; never the value, key, nonce or tag. */
export class CredentialError extends Error {
  readonly reason: CredentialErrorReason;
  readonly code: string;

  constructor(reason: CredentialErrorReason, message = `Stored credential unavailable (${reason})`) {
    super(message);
    this.name = "CredentialError";
    this.reason = reason;
    this.code = `CREDENTIAL_${reason.toUpperCase()}`;
  }
}

// ── Key configuration ──────────────────────────────────────────────────

export interface CredentialKeyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
  legacyReads: boolean;
  legacyCbcKey: Buffer | null;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const configError = (detail: string) => new CredentialError("key_config", `Credential encryption is misconfigured: ${detail}`);

function strictBase64(raw: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const decoded = Buffer.from(raw, "base64");
  return decoded.toString("base64") === raw ? decoded : null;
}

/**
 * Parses and validates key configuration. Error messages name the variable
 * and entry position only, never any key material.
 */
export function parseKeyring(env: NodeJS.ProcessEnv): CredentialKeyring {
  const rawKeys = (env.CREDENTIAL_ENCRYPTION_KEYS ?? "").trim();
  if (!rawKeys) throw configError("CREDENTIAL_ENCRYPTION_KEYS is not set");
  const keys = new Map<string, Buffer>();
  rawKeys.split(",").forEach((entry, index) => {
    const separator = entry.indexOf("=");
    const id = entry.slice(0, separator).trim();
    const key = separator > 0 ? strictBase64(entry.slice(separator + 1).trim()) : null;
    if (separator <= 0 || !KEY_ID.test(id)) {
      throw configError(`CREDENTIAL_ENCRYPTION_KEYS entry ${index + 1} must be <keyId>=<base64 key> with keyId [A-Za-z0-9_-]{1,32}`);
    }
    if (!key || key.length !== 32) {
      throw configError(`CREDENTIAL_ENCRYPTION_KEYS entry ${index + 1} is not a base64-encoded 32-byte key`);
    }
    if (key.equals(Buffer.alloc(32))) throw configError(`CREDENTIAL_ENCRYPTION_KEYS entry ${index + 1} is all zeros`);
    if (keys.has(id)) throw configError(`CREDENTIAL_ENCRYPTION_KEYS has duplicate keyId at entry ${index + 1}`);
    keys.set(id, key);
  });

  const activeKeyId = (env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID ?? "").trim();
  if (!activeKeyId) throw configError("CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID is not set");
  if (!keys.has(activeKeyId)) throw configError("CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID does not name a configured key");

  // The credential key must be dedicated: not the JWT-derived legacy key and
  // not another application signing key.
  const reserved: Array<[string, Buffer | null]> = [
    ["JWT_SECRET", env.JWT_SECRET ? createHash("sha256").update(env.JWT_SECRET).digest() : null],
    ["JWT_SECRET", env.JWT_SECRET ? Buffer.from(env.JWT_SECRET, "utf8") : null],
    ["MEDIA_SESSION_SIGNING_KEY", env.MEDIA_SESSION_SIGNING_KEY ? Buffer.from(env.MEDIA_SESSION_SIGNING_KEY, "base64") : null],
    ["WIDGET_VERIFICATION_KEY", env.WIDGET_VERIFICATION_KEY ? Buffer.from(env.WIDGET_VERIFICATION_KEY, "base64") : null],
  ];
  for (const key of keys.values()) {
    for (const [name, other] of reserved) {
      if (other && other.equals(key)) throw configError(`a credential key reuses or is derived from ${name}`);
    }
  }

  const legacyMode = (env.CREDENTIAL_LEGACY_READS ?? "enabled").trim();
  if (legacyMode !== "enabled" && legacyMode !== "disabled") {
    throw configError("CREDENTIAL_LEGACY_READS must be 'enabled' or 'disabled'");
  }
  const cbcSource = (env.CREDENTIAL_LEGACY_CBC_KEY_SOURCE ?? "").trim();
  let legacyCbcKey: Buffer | null = null;
  if (cbcSource) {
    if (cbcSource !== "jwt_secret") throw configError("CREDENTIAL_LEGACY_CBC_KEY_SOURCE must be 'jwt_secret' or unset");
    if (!env.JWT_SECRET) throw configError("CREDENTIAL_LEGACY_CBC_KEY_SOURCE=jwt_secret requires JWT_SECRET");
    legacyCbcKey = createHash("sha256").update(env.JWT_SECRET).digest();
  }

  return { activeKeyId, keys, legacyReads: legacyMode === "enabled", legacyCbcKey };
}

// ── Codec ──────────────────────────────────────────────────────────────

const PREFIX = "enc:";
const V1 = /^enc:v1:([A-Za-z0-9_-]{1,32}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]*):([A-Za-z0-9_-]{22})$/;
const LEGACY_CBC = /^[0-9a-f]{32}:(?:[0-9a-f]{32})+$/;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type CredentialFormat = "empty" | "v1" | "legacy_plaintext" | "legacy_cbc" | "invalid";

function aad(field: CredentialField, ownerId: number, keyId: string): Buffer {
  return Buffer.from(`dialog-credential:v1:${keyId}:${CREDENTIAL_FIELDS[field].column}:${ownerId}`, "utf8");
}

function assertOwner(ownerId: number): void {
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new CredentialError("format", "Credential owner is invalid");
}

const decodeLegacyText = new TextDecoder("utf-8", { fatal: true });

export interface CredentialCodec {
  readonly activeKeyId: string;
  seal(field: CredentialField, ownerId: number, plaintext: string): string;
  /** Returns null only for an absent (null/empty) value; otherwise decrypts or throws. */
  open(field: CredentialField, ownerId: number, stored: string | null | undefined): string | null;
  /** Format and key id of a stored value, for migration reports. Never decrypts. */
  inspect(field: CredentialField, stored: string | null | undefined): { format: CredentialFormat; keyId?: string };
  /** True when the stored value is not v1 under the active key. */
  needsReencryption(field: CredentialField, stored: string | null | undefined): boolean;
}

export function createCredentialCodec(keyring: CredentialKeyring): CredentialCodec {
  function inspect(field: CredentialField, stored: string | null | undefined) {
    if (stored === null || stored === undefined || stored === "") return { format: "empty" as const };
    if (stored.startsWith(PREFIX)) {
      const match = V1.exec(stored);
      return match ? { format: "v1" as const, keyId: match[1] } : { format: "invalid" as const };
    }
    if (CREDENTIAL_FIELDS[field].legacy === "cbc") {
      return LEGACY_CBC.test(stored) ? { format: "legacy_cbc" as const } : { format: "invalid" as const };
    }
    return { format: "legacy_plaintext" as const };
  }

  function openV1(field: CredentialField, ownerId: number, stored: string): string {
    const [, keyId, ...segments] = V1.exec(stored)!;
    // base64url has spare bits in the final character; only the canonical
    // encoding is accepted so each stored value has exactly one valid form.
    const [nonce, ciphertext, tag] = segments.map((segment) => {
      const bytes = Buffer.from(segment, "base64url");
      if (bytes.toString("base64url") !== segment) throw new CredentialError("format");
      return bytes;
    });
    const key = keyring.keys.get(keyId);
    if (!key) throw new CredentialError("unknown_key");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(field, ownerId, keyId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new CredentialError("authentication");
    }
  }

  function openLegacyCbc(stored: string): string {
    if (!keyring.legacyCbcKey) throw new CredentialError("legacy_key_unavailable");
    const [ivHex, dataHex] = [stored.slice(0, 32), stored.slice(33)];
    let text: string;
    try {
      const decipher = createDecipheriv("aes-256-cbc", keyring.legacyCbcKey, Buffer.from(ivHex, "hex"));
      const bytes = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
      text = decodeLegacyText.decode(bytes);
    } catch {
      throw new CredentialError("legacy_decrypt");
    }
    // CBC is unauthenticated: a wrong key can still pass the padding check.
    // Real credentials are printable, so control characters mean a bad key.
    if (text.length === 0 || /[\u0000-\u001f\u007f]/.test(text)) throw new CredentialError("legacy_decrypt");
    return text;
  }

  return {
    activeKeyId: keyring.activeKeyId,
    seal(field, ownerId, plaintext) {
      assertOwner(ownerId);
      if (typeof plaintext !== "string" || plaintext.length === 0) {
        throw new CredentialError("format", "Credential value must be a non-empty string");
      }
      const keyId = keyring.activeKeyId;
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", keyring.keys.get(keyId)!, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad(field, ownerId, keyId));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${PREFIX}v1:${keyId}:${nonce.toString("base64url")}:${ciphertext.toString("base64url")}:${tag.toString("base64url")}`;
    },
    open(field, ownerId, stored) {
      assertOwner(ownerId);
      const { format } = inspect(field, stored);
      switch (format) {
        case "empty":
          return null;
        case "v1":
          return openV1(field, ownerId, stored!);
        case "legacy_plaintext":
          if (!keyring.legacyReads) throw new CredentialError("legacy_disabled");
          return stored!;
        case "legacy_cbc":
          if (!keyring.legacyReads) throw new CredentialError("legacy_disabled");
          return openLegacyCbc(stored!);
        default:
          throw new CredentialError("format");
      }
    },
    inspect,
    needsReencryption(field, stored) {
      const info = inspect(field, stored);
      return info.format !== "empty" && !(info.format === "v1" && info.keyId === keyring.activeKeyId);
    },
  };
}

// ── Process-wide codec ─────────────────────────────────────────────────

let processCodec: CredentialCodec | null = null;

/** Validates configuration from the environment; called at startup and on first use. */
export function credentialCodec(): CredentialCodec {
  processCodec ??= createCredentialCodec(parseKeyring(process.env));
  return processCodec;
}

export const sealCredential = (field: CredentialField, ownerId: number, plaintext: string) =>
  credentialCodec().seal(field, ownerId, plaintext);

export const openCredential = (field: CredentialField, ownerId: number, stored: string | null | undefined) =>
  credentialCodec().open(field, ownerId, stored);
