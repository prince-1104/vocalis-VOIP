// Phase 1G: tenant credentials are stored with authenticated encryption under
// a dedicated key. All secrets here are synthetic; the only network peer is
// the loopback HTTPS CRM fixture.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { Server as HttpsServer } from "node:https";
import express from "express";
import twilio from "twilio";
import { rows, resetDatabase, db, agentConfigsTable } from "./fake-db";
import { logs, emitted, resetLogs } from "./capture-logger";
import { listenCrmFixture } from "./fake-crm-http";
import {
  CREDENTIAL_FIELDS,
  CredentialError,
  createCredentialCodec,
  parseKeyring,
  sealCredential,
  openCredential,
  type CredentialCodec,
  type CredentialField,
} from "../src/lib/credential-crypto";
import { migrateCredentials } from "../src/lib/credential-migration";
import { twilioAuthTokenFor } from "../src/lib/tenant-credentials";
import { hasValidTwilioSignature } from "../src/lib/twilio-webhook-auth";
import { resolveTelephonyForUser } from "../src/lib/telephony/resolve-telephony";
import {
  fetchExternalCrmData,
  invalidateExternalCrmConfigCache,
  testExternalCrmLookup,
} from "../src/lib/external-crm-lookup";
import { signWebhookPayload } from "../src/lib/crm-auth";
import { startWebhookDispatcher } from "../src/lib/webhook-dispatcher";
import { crmEventBus } from "../src/lib/crm-event-bus";
import agentsRouter from "../src/routes/agents";
import adminRouter from "../src/routes/admin";
import externalCrmRouter from "../src/routes/external-crm";
import crmRouter from "../src/routes/crm";

// The process codec is built lazily, so this explicit opt-in applies to the
// application modules under test (legacy CBC rows are readable).
process.env.CREDENTIAL_LEGACY_CBC_KEY_SOURCE = "jwt_secret";
const JWT = process.env.JWT_SECRET!;

after(() => {
  for (const timer of (globalThis as any).__dialogTestIntervals) clearInterval(timer);
});

const K0 = Buffer.alloc(32, 20).toString("base64");
const K1 = Buffer.alloc(32, 21).toString("base64");
const K2 = Buffer.alloc(32, 22).toString("base64");
const BASE_ENV = { JWT_SECRET: JWT, CREDENTIAL_ENCRYPTION_KEYS: `k1=${K1}`, CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "k1" };
const codecFor = (env: Record<string, string | undefined> = {}): CredentialCodec =>
  createCredentialCodec(parseKeyring({ ...BASE_ENV, ...env } as NodeJS.ProcessEnv));

const SECRET = "fake-provider-secret-Ωé-0123456789";
const TOKEN_A = "fake-twilio-token-tenant-a";
const TOKEN_B = "fake-twilio-token-tenant-b";
const CRM_AUTH = "fake-crm-bearer-value";
const WEBHOOK_SECRET = "fake-webhook-signing-secret";
const SIP_PASSWORD = "fake-sip-password";
const EXOTEL_KEY = "fake-exotel-api-key";
const EXOTEL_TOKEN = "fake-exotel-api-token";
const ALL_SECRETS = [SECRET, TOKEN_A, TOKEN_B, CRM_AUTH, WEBHOOK_SECRET, SIP_PASSWORD, EXOTEL_KEY, EXOTEL_TOKEN, K0, K1, K2];

/** The format the removed AES-256-CBC helper produced (key = sha256(JWT_SECRET)). */
function legacyCbc(plaintext: string, jwtSecret = JWT): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", createHash("sha256").update(jwtSecret).digest(), iv);
  return `${iv.toString("hex")}:${Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("hex")}`;
}

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CredentialError, `expected CredentialError, got ${String(err)}`);
    for (const secret of ALL_SECRETS) assert.ok(!err.message.includes(secret), "error message leaks a secret");
    return err.reason;
  }
  assert.fail("expected the credential operation to fail");
}

function assertNoLeak(extra: string[] = []) {
  const output = emitted();
  for (const secret of [...ALL_SECRETS, ...extra]) assert.ok(!output.includes(secret), "log output leaks a secret");
  assert.ok(!output.includes("enc:v1:"), "log output contains stored ciphertext");
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** Replaces the first character: always changes the decoded bytes. */
const flipFirst = (segment: string) => (segment[0] === "A" ? "B" : "A") + segment.slice(1);
/** Flips only a spare low bit of the final character: same bytes, non-canonical text. */
const flipSpareBit = (segment: string) =>
  segment.slice(0, -1) + B64URL[B64URL.indexOf(segment.at(-1)!) ^ 1];
const withSegment = (stored: string, index: number, change: (s: string) => string) => {
  const parts = stored.split(":");
  parts[index] = change(parts[index]);
  return parts.join(":");
};

// Loopback HTTPS stand-in for tenant CRMs and webhook receivers.
type Hit = { path: string; authorization?: string; signature?: string; body: string };
const hits: Hit[] = [];
let fixture: HttpsServer;
let crmBase = "";
before(async () => {
  ({ server: fixture, base: crmBase } = await listenCrmFixture((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      hits.push({
        path: new URL(req.url ?? "/", "https://fixture.invalid").pathname,
        authorization: req.headers.authorization,
        signature: req.headers["x-dialog-signature"] as string | undefined,
        body,
      });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ customer: { name: "Synthetic Customer" } }));
    });
  }));
});
after(() => {
  fixture.closeAllConnections();
  fixture.close();
});

beforeEach(() => {
  resetDatabase();
  resetLogs();
  hits.length = 0;
});

// ── Authenticated encryption ───────────────────────────────────────────

test("v1 round-trips every field with a fresh nonce and never contains the plaintext", () => {
  const codec = codecFor();
  for (const field of Object.keys(CREDENTIAL_FIELDS) as CredentialField[]) {
    const first = codec.seal(field, 7, SECRET);
    const second = codec.seal(field, 7, SECRET);
    assert.match(first, /^enc:v1:k1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]{22}$/);
    assert.notEqual(first, second, "same input encrypts differently");
    assert.notEqual(first.split(":")[3], second.split(":")[3], "nonce is unique per encryption");
    assert.ok(!first.includes(SECRET) && !first.includes(Buffer.from(SECRET).toString("base64url")));
    assert.equal(codec.open(field, 7, first), SECRET);
    assert.equal(codec.open(field, 7, second), SECRET);
    assert.deepEqual(codec.inspect(field, first), { format: "v1", keyId: "k1" });
    assert.equal(codec.needsReencryption(field, first), false);
  }
  const nonces = new Set(Array.from({ length: 500 }, () => codec.seal("crmAuthValue", 1, "x").split(":")[3]));
  assert.equal(nonces.size, 500);
  assert.equal(codec.open("crmAuthValue", 1, null), null);
  assert.equal(codec.open("crmAuthValue", 1, ""), null);
  assert.equal(reasonOf(() => codec.seal("crmAuthValue", 1, "")), "format");
  assert.equal(reasonOf(() => codec.seal("crmAuthValue", 0, SECRET)), "format");
});

test("tampered nonce, ciphertext, tag, key id, truncation and non-canonical encodings fail closed", () => {
  const codec = codecFor({ CREDENTIAL_ENCRYPTION_KEYS: `k1=${K1},k2=${K2}` });
  const stored = codec.seal("twilioAuthToken", 10, SECRET);
  const cases: Array<[string, string, string[]]> = [
    ["nonce", withSegment(stored, 3, flipFirst), ["authentication"]],
    ["ciphertext", withSegment(stored, 4, flipFirst), ["authentication"]],
    ["tag", withSegment(stored, 5, flipFirst), ["authentication"]],
    ["key id swapped", withSegment(stored, 2, () => "k2"), ["authentication"]],
    ["ciphertext truncated", withSegment(stored, 4, (s) => s.slice(0, -4)), ["authentication", "format"]],
    ["ciphertext extended", withSegment(stored, 4, (s) => s + "AAAA"), ["authentication"]],
    ["ciphertext emptied", withSegment(stored, 4, () => ""), ["authentication"]],
    ["tag truncated", stored.slice(0, -2), ["format"]],
    ["tag non-canonical", withSegment(stored, 5, flipSpareBit), ["format"]],
    ["unknown version", stored.replace("enc:v1:", "enc:v2:"), ["format"]],
    ["missing segment", stored.split(":").slice(0, 5).join(":"), ["format"]],
    ["whitespace", `${stored} `, ["format"]],
  ];
  for (const [name, value, reasons] of cases) {
    assert.notEqual(value, stored, name);
    const reason = reasonOf(() => codec.open("twilioAuthToken", 10, value));
    assert.ok(reasons.includes(reason), `${name}: ${reason}`);
  }
});

test("a wrong key, an unknown key id, another tenant or another column cannot decrypt", () => {
  const stored = codecFor().seal("twilioAuthToken", 10, SECRET);
  const wrongKey = codecFor({ CREDENTIAL_ENCRYPTION_KEYS: `k1=${K2}` });
  assert.equal(reasonOf(() => wrongKey.open("twilioAuthToken", 10, stored)), "authentication");
  const otherId = codecFor({ CREDENTIAL_ENCRYPTION_KEYS: `k2=${K2}`, CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "k2" });
  assert.equal(reasonOf(() => otherId.open("twilioAuthToken", 10, stored)), "unknown_key");
  const codec = codecFor();
  assert.equal(reasonOf(() => codec.open("twilioAuthToken", 11, stored)), "authentication");
  assert.equal(reasonOf(() => codec.open("telephonyApiSecret", 10, stored)), "authentication");
  assert.equal(reasonOf(() => codec.open("crmWebhookSecret", 10, stored)), "authentication");
});

// ── Key configuration ──────────────────────────────────────────────────

test("key configuration is mandatory, strictly validated and never echoed", () => {
  const sha = createHash("sha256").update(JWT).digest("base64");
  const media = Buffer.alloc(32, 7).toString("base64");
  const bad: Array<Record<string, string | undefined>> = [
    { CREDENTIAL_ENCRYPTION_KEYS: undefined },
    { CREDENTIAL_ENCRYPTION_KEYS: "" },
    { CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: undefined },
    { CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "k9" },
    { CREDENTIAL_ENCRYPTION_KEYS: K1 },
    { CREDENTIAL_ENCRYPTION_KEYS: `=${K1}` },
    { CREDENTIAL_ENCRYPTION_KEYS: `k 1=${K1}`, CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "k 1" },
    { CREDENTIAL_ENCRYPTION_KEYS: `${"k".repeat(33)}=${K1}`, CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "k".repeat(33) },
    { CREDENTIAL_ENCRYPTION_KEYS: `k1=${Buffer.alloc(31, 1).toString("base64")}` },
    { CREDENTIAL_ENCRYPTION_KEYS: `k1=${Buffer.alloc(33, 1).toString("base64")}` },
    { CREDENTIAL_ENCRYPTION_KEYS: `k1=${Buffer.alloc(32, 1).toString("hex")}` },
    { CREDENTIAL_ENCRYPTION_KEYS: `k1=${K1.slice(0, -2)}` },
    { CREDENTIAL_ENCRYPTION_KEYS: `k1=${Buffer.alloc(32, 21).toString("base64url")}!` },
    { CREDENTIAL_ENCRYPTION_KEYS: `k1=${Buffer.alloc(32).toString("base64")}` },
    { CREDENTIAL_ENCRYPTION_KEYS: `k1=${K1},k1=${K2}` },
    { CREDENTIAL_ENCRYPTION_KEYS: `k1=${sha}` },
    { CREDENTIAL_ENCRYPTION_KEYS: `k1=${media}`, MEDIA_SESSION_SIGNING_KEY: media },
    { CREDENTIAL_ENCRYPTION_KEYS: `k1=${K1}`, WIDGET_VERIFICATION_KEY: K1 },
    { CREDENTIAL_ENCRYPTION_KEYS: `k1=${K1}`, JWT_SECRET: Buffer.alloc(32, 21).toString("latin1") },
    { CREDENTIAL_LEGACY_READS: "yes" },
    { CREDENTIAL_LEGACY_CBC_KEY_SOURCE: "default" },
    { CREDENTIAL_LEGACY_CBC_KEY_SOURCE: "jwt_secret", JWT_SECRET: undefined },
  ];
  for (const env of bad) {
    let error: unknown;
    try {
      parseKeyring({ ...BASE_ENV, ...env } as NodeJS.ProcessEnv);
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof CredentialError, JSON.stringify(Object.keys(env)));
    assert.equal(error.reason, "key_config");
    assert.equal(error.code, "CREDENTIAL_KEY_CONFIG");
    assert.match(error.message, /^Credential encryption is misconfigured: /);
    for (const material of [K1, K2, sha, media, JWT]) assert.ok(!error.message.includes(material), "message echoes key material");
  }
  const keyring = parseKeyring({ ...BASE_ENV, CREDENTIAL_ENCRYPTION_KEYS: ` k0=${K0} , k1=${K1} ` } as NodeJS.ProcessEnv);
  assert.deepEqual([...keyring.keys.keys()], ["k0", "k1"]);
  assert.equal(keyring.legacyReads, true, "legacy reads default to enabled for the transition");
  assert.equal(keyring.legacyCbcKey, null, "the JWT-derived legacy key is never used implicitly");
});

// ── Rotation and legacy compatibility ──────────────────────────────────

test("rotation: old-key values still open, writes use the active key, and retired keys stop working", () => {
  const before = codecFor({ CREDENTIAL_ENCRYPTION_KEYS: `k1=${K1}` });
  const old = before.seal("crmAuthValue", 3, SECRET);
  const rotating = codecFor({ CREDENTIAL_ENCRYPTION_KEYS: `k1=${K1},k2=${K2}`, CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "k2" });
  assert.equal(rotating.open("crmAuthValue", 3, old), SECRET);
  assert.equal(rotating.needsReencryption("crmAuthValue", old), true);
  const fresh = rotating.seal("crmAuthValue", 3, SECRET);
  assert.deepEqual(rotating.inspect("crmAuthValue", fresh), { format: "v1", keyId: "k2" });
  assert.equal(rotating.needsReencryption("crmAuthValue", fresh), false);
  // Rolling back the active id (k2 still configured) keeps both readable.
  const rolledBack = codecFor({ CREDENTIAL_ENCRYPTION_KEYS: `k1=${K1},k2=${K2}` });
  assert.equal(rolledBack.open("crmAuthValue", 3, fresh), SECRET);
  const retired = codecFor({ CREDENTIAL_ENCRYPTION_KEYS: `k2=${K2}`, CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "k2" });
  assert.equal(retired.open("crmAuthValue", 3, fresh), SECRET);
  assert.equal(reasonOf(() => retired.open("crmAuthValue", 3, old)), "unknown_key");
});

test("legacy plaintext columns are readable only while legacy reads are enabled", () => {
  const enabled = codecFor();
  const disabled = codecFor({ CREDENTIAL_LEGACY_READS: "disabled" });
  for (const field of ["twilioAuthToken", "telephonyApiKey", "telephonyApiSecret", "crmAuthValue", "crmWebhookSecret"] as const) {
    assert.deepEqual(enabled.inspect(field, SECRET), { format: "legacy_plaintext" });
    assert.equal(enabled.open(field, 1, SECRET), SECRET);
    assert.equal(enabled.needsReencryption(field, SECRET), true);
    assert.equal(reasonOf(() => disabled.open(field, 1, SECRET)), "legacy_disabled");
    // Anything in the encrypted namespace is never treated as plaintext.
    assert.equal(reasonOf(() => enabled.open(field, 1, "enc:something-else")), "format");
  }
  // CBC-shaped text in a plaintext column is still just plaintext.
  const cbcLooking = legacyCbc(SECRET);
  assert.equal(enabled.open("twilioAuthToken", 1, cbcLooking), cbcLooking);
});

test("legacy CBC columns decrypt only with the explicit JWT key source and fail closed otherwise", () => {
  const withSource = codecFor({ CREDENTIAL_LEGACY_CBC_KEY_SOURCE: "jwt_secret" });
  const withoutSource = codecFor();
  const disabled = codecFor({ CREDENTIAL_LEGACY_CBC_KEY_SOURCE: "jwt_secret", CREDENTIAL_LEGACY_READS: "disabled" });
  const otherJwt = codecFor({ CREDENTIAL_LEGACY_CBC_KEY_SOURCE: "jwt_secret", JWT_SECRET: "fake-rotated-jwt-secret" });
  for (const field of ["sipPassword", "exotelApiKey", "exotelApiToken"] as const) {
    const stored = legacyCbc(SECRET);
    assert.deepEqual(withSource.inspect(field, stored), { format: "legacy_cbc" });
    assert.equal(withSource.open(field, 4, stored), SECRET);
    assert.equal(withSource.open(field, 999, stored), SECRET, "legacy CBC is not owner-bound (documented limitation)");
    assert.equal(reasonOf(() => withoutSource.open(field, 4, stored)), "legacy_key_unavailable");
    assert.equal(reasonOf(() => disabled.open(field, 4, stored)), "legacy_disabled");
    // Plaintext in a CBC column is never returned as if it were a credential.
    for (const value of [SECRET, "abcd:1234", stored.toUpperCase(), stored.slice(0, -2), stored.replace(":", ""), `${stored}:00`]) {
      assert.equal(reasonOf(() => withSource.open(field, 4, value)), "format", value.slice(0, 8));
    }
    // CBC is unauthenticated: a wrong key or tampered body must not yield text.
    for (let i = 0; i < 20; i++) {
      assert.equal(reasonOf(() => otherJwt.open(field, 4, legacyCbc(`${SECRET}-${i}`))), "legacy_decrypt");
      const body = legacyCbc(`${SECRET}-${i}`);
      const tampered = body.slice(0, 33) + (body[33] === "0" ? "1" : "0") + body.slice(34);
      assert.notEqual(
        (() => {
          try {
            return withSource.open(field, 4, tampered);
          } catch (err) {
            assert.ok(err instanceof CredentialError && err.reason === "legacy_decrypt");
            return null;
          }
        })(),
        `${SECRET}-${i}`,
      );
    }
  }
});

// ── Explicit migration ─────────────────────────────────────────────────

function seedMixedStorage(oldCodec: CredentialCodec) {
  rows.agent_configs = [
    { id: 1, userId: 10, twilioAuthToken: TOKEN_A, telephonyApiKey: null, telephonyApiSecret: "" },
    { id: 2, userId: 20, twilioAuthToken: oldCodec.seal("twilioAuthToken", 20, TOKEN_B), telephonyApiKey: "fake-byoc-key", telephonyApiSecret: null },
  ];
  rows.external_crm_configs = [{ id: 1, userId: 10, authValue: CRM_AUTH }];
  rows.crm_api_keys = [{ id: 1, userId: 10, webhookSecret: WEBHOOK_SECRET }];
  rows.sip_trunk_configs = [{ id: 1, tenantId: 1, sipPassword: legacyCbc(SIP_PASSWORD) }];
  rows.exotel_configs = [{ id: 1, tenantId: 1, apiKey: legacyCbc(EXOTEL_KEY), apiToken: "not-a-cbc-value" }];
}
const EXPECTED: Array<[string, number, string, CredentialField, number, string]> = [
  ["agent_configs", 0, "twilioAuthToken", "twilioAuthToken", 10, TOKEN_A],
  ["agent_configs", 1, "twilioAuthToken", "twilioAuthToken", 20, TOKEN_B],
  ["agent_configs", 1, "telephonyApiKey", "telephonyApiKey", 20, "fake-byoc-key"],
  ["external_crm_configs", 0, "authValue", "crmAuthValue", 10, CRM_AUTH],
  ["crm_api_keys", 0, "webhookSecret", "crmWebhookSecret", 10, WEBHOOK_SECRET],
  ["sip_trunk_configs", 0, "sipPassword", "sipPassword", 1, SIP_PASSWORD],
  ["exotel_configs", 0, "apiKey", "exotelApiKey", 1, EXOTEL_KEY],
];
const migrationCodec = () =>
  codecFor({ CREDENTIAL_ENCRYPTION_KEYS: `k0=${K0},k1=${K1}`, CREDENTIAL_LEGACY_CBC_KEY_SOURCE: "jwt_secret" });

test("migration dry run writes nothing; apply verifies, re-encrypts and is idempotent; failures are left untouched", async () => {
  seedMixedStorage(codecFor({ CREDENTIAL_ENCRYPTION_KEYS: `k0=${K0}`, CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "k0" }));
  const codec = migrationCodec();
  const snapshot = JSON.stringify(rows);

  const dry = await migrateCredentials(db, codec, { apply: false });
  assert.equal(JSON.stringify(rows), snapshot, "dry run must not write");
  assert.equal(dry.complete, false);
  const col = (report: typeof dry, field: string) => report.columns.find((c) => c.field === field)!;
  assert.deepEqual(col(dry, "twilioAuthToken").pendingByFormat, { legacy_plaintext: 1, "v1:k0": 1 });
  assert.equal(col(dry, "telephonyApiSecret").empty, 2);
  assert.deepEqual(col(dry, "sipPassword").pendingByFormat, { legacy_cbc: 1 });
  assert.deepEqual(col(dry, "exotelApiToken").failed, { format: 1 });
  const reportText = JSON.stringify(dry);
  for (const secret of ALL_SECRETS) assert.ok(!reportText.includes(secret), "report contains a secret");
  assert.ok(!reportText.includes("enc:"), "report contains ciphertext");

  const applied = await migrateCredentials(db, codec, { apply: true });
  assert.equal(applied.columns.reduce((n, c) => n + c.reencrypted, 0), EXPECTED.length);
  for (const [table, index, property, field, owner, plaintext] of EXPECTED) {
    const stored = rows[table][index][property];
    assert.deepEqual(codec.inspect(field, stored), { format: "v1", keyId: "k1" }, `${table}.${property}`);
    assert.equal(codec.open(field, owner, stored), plaintext);
  }
  assert.equal(rows.exotel_configs[0].apiToken, "not-a-cbc-value", "undecryptable value is left as found");
  assert.equal(rows.agent_configs[0].telephonyApiSecret, "", "empty values are not invented");
  assert.equal(applied.complete, false, "a failed value keeps the migration incomplete");

  const again = await migrateCredentials(db, codec, { apply: true });
  assert.equal(again.columns.reduce((n, c) => n + c.reencrypted, 0), 0, "second run has nothing to do");

  // After migration the old key and both legacy paths can be retired.
  const retired = codecFor({ CREDENTIAL_LEGACY_READS: "disabled" });
  for (const [table, index, property, field, owner, plaintext] of EXPECTED) {
    assert.equal(retired.open(field, owner, rows[table][index][property]), plaintext);
  }
  rows.exotel_configs[0].apiToken = retired.seal("exotelApiToken", 1, EXOTEL_TOKEN);
  assert.equal((await migrateCredentials(db, retired, { apply: false })).complete, true);
});

test("migration never overwrites a credential changed concurrently, and parallel runs write each value once", async () => {
  seedMixedStorage(codecFor({ CREDENTIAL_ENCRYPTION_KEYS: `k0=${K0}`, CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "k0" }));
  const codec = migrationCodec();
  let raced = false;
  const racing = {
    ...db,
    update(table: any) {
      if (table === agentConfigsTable && !raced) {
        raced = true;
        // An administrator saves a new token between the migration's read and write.
        rows.agent_configs[0].twilioAuthToken = codec.seal("twilioAuthToken", 10, "fake-admin-updated-token");
      }
      return db.update(table);
    },
  };
  const report = await migrateCredentials(racing, codec, { apply: true });
  const twilioColumn = report.columns.find((c) => c.field === "twilioAuthToken")!;
  assert.equal(twilioColumn.skippedConcurrent, 1);
  assert.equal(codec.open("twilioAuthToken", 10, rows.agent_configs[0].twilioAuthToken), "fake-admin-updated-token");
  assert.equal(report.complete, false, "a skipped row needs another run");

  resetDatabase();
  seedMixedStorage(codecFor({ CREDENTIAL_ENCRYPTION_KEYS: `k0=${K0}`, CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "k0" }));
  const [first, second] = await Promise.all([
    migrateCredentials(db, codec, { apply: true }),
    migrateCredentials(db, codec, { apply: true }),
  ]);
  const written = [first, second].reduce((n, r) => n + r.columns.reduce((m, c) => m + c.reencrypted, 0), 0);
  assert.equal(written, EXPECTED.length, "each value is re-encrypted exactly once");
  for (const [table, index, property, field, owner, plaintext] of EXPECTED) {
    assert.equal(codec.open(field, owner, rows[table][index][property]), plaintext);
  }
});

test("rotation migration moves every value to the new key so the old key can be retired", async () => {
  const k1 = codecFor({ CREDENTIAL_LEGACY_CBC_KEY_SOURCE: "jwt_secret" });
  seedMixedStorage(k1);
  rows.exotel_configs[0].apiToken = legacyCbc(EXOTEL_TOKEN);
  await migrateCredentials(db, k1, { apply: true });
  const rotating = codecFor({ CREDENTIAL_ENCRYPTION_KEYS: `k1=${K1},k2=${K2}`, CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "k2" });
  const dry = await migrateCredentials(db, rotating, { apply: false });
  assert.deepEqual(dry.columns.find((c) => c.field === "twilioAuthToken")!.pendingByFormat, { "v1:k1": 2 });
  const result = await migrateCredentials(db, rotating, { apply: true });
  assert.equal(result.complete, true);
  const k2Only = codecFor({ CREDENTIAL_ENCRYPTION_KEYS: `k2=${K2}`, CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "k2", CREDENTIAL_LEGACY_READS: "disabled" });
  for (const [table, index, property, field, owner, plaintext] of EXPECTED) {
    assert.equal(k2Only.open(field, owner, rows[table][index][property]), plaintext);
  }
  assert.equal(k2Only.open("exotelApiToken", 1, rows.exotel_configs[0].apiToken), EXOTEL_TOKEN);
});

// ── Integrations receive usable credentials; tenants stay isolated ─────

const ORIGIN = "https://dialog.test";
const ACCOUNT_A = "AC" + "a".repeat(32);
const ACCOUNT_B = "AC" + "b".repeat(32);

function seedTenants() {
  rows.tenants = [
    { id: 1, ownerId: 10, status: "active", slug: "a", telephonyType: "TWILIO" },
    { id: 2, ownerId: 20, status: "active", slug: "b", telephonyType: "TWILIO" },
  ];
  rows.agent_configs = [
    { id: 1, userId: 10, twilioAccountSid: ACCOUNT_A, twilioAuthToken: sealCredential("twilioAuthToken", 10, TOKEN_A), phoneNumber: "+15550000001", widgetApiKey: "fake-widget-key-a" },
    { id: 2, userId: 20, twilioAccountSid: ACCOUNT_B, twilioAuthToken: sealCredential("twilioAuthToken", 20, TOKEN_B), phoneNumber: "+15550000002", widgetApiKey: "fake-widget-key-b" },
  ];
}

function signedRequest(token: string, account: string) {
  const urlPath = "/api/twilio/status?callLogId=1";
  const body = { AccountSid: account, CallSid: "CA" + "c".repeat(32), CallStatus: "completed" };
  const signature = twilio.getExpectedTwilioSignature(token, ORIGIN + urlPath, body);
  return { body, originalUrl: urlPath, get: (name: string) => (name.toLowerCase() === "x-twilio-signature" ? signature : undefined) } as any;
}

test("Twilio signature checks and dialing receive the decrypted per-tenant token", async () => {
  seedTenants();
  const [agentA, agentB] = rows.agent_configs;
  assert.equal(twilioAuthTokenFor(agentA), TOKEN_A);
  assert.equal(hasValidTwilioSignature(signedRequest(TOKEN_A, ACCOUNT_A), agentA), true);
  assert.equal(hasValidTwilioSignature(signedRequest(TOKEN_B, ACCOUNT_B), agentB), true);
  assert.equal(hasValidTwilioSignature(signedRequest(TOKEN_B, ACCOUNT_A), agentA), false);
  // A legacy plaintext row keeps working during the transition.
  agentA.twilioAuthToken = TOKEN_A;
  assert.equal(hasValidTwilioSignature(signedRequest(TOKEN_A, ACCOUNT_A), agentA), true);

  agentA.twilioAuthToken = sealCredential("twilioAuthToken", 10, TOKEN_A);
  const context = await resolveTelephonyForUser(10, "+15550009999");
  assert.equal(context.provider, "TWILIO");
  assert.equal((context as any).twilioAuthToken, TOKEN_A);
  assertNoLeak();
});

test("a ciphertext copied into another tenant's row does not decrypt there", async () => {
  seedTenants();
  const [agentA, agentB] = rows.agent_configs;
  agentB.twilioAuthToken = agentA.twilioAuthToken;
  agentB.twilioAccountSid = ACCOUNT_A;
  assert.equal(twilioAuthTokenFor(agentB), null);
  assert.equal(hasValidTwilioSignature(signedRequest(TOKEN_A, ACCOUNT_A), agentB), false);
  await assert.rejects(resolveTelephonyForUser(20, "+15550009999"), { message: "Failed to decrypt Twilio credentials." });
  const unavailable = logs.filter((l) => l.event === "credential_unavailable");
  assert.ok(unavailable.length >= 2);
  assert.ok(unavailable.every((l) => l.field === "twilioAuthToken" && l.ownerId === 20 && l.reason === "authentication"));
  // Same for tenant-owned telephony: tenant 2 cannot use tenant 1's Exotel token.
  rows.tenants[1].telephonyType = "EXOTEL";
  rows.exotel_configs = [
    { id: 2, tenantId: 2, isEnabled: true, accountSid: "fake", exophone: "+15550000003", region: "mumbai", appFlowUrl: "https://dialog.test/flow",
      apiKey: sealCredential("exotelApiKey", 2, EXOTEL_KEY), apiToken: sealCredential("exotelApiToken", 1, EXOTEL_TOKEN) },
  ];
  await assert.rejects(resolveTelephonyForUser(20, "+15550009999"), { message: "Failed to decrypt Exotel credentials." });
  assertNoLeak();
});

test("SIP and Exotel resolve from v1 and from explicitly enabled legacy CBC storage", async () => {
  seedTenants();
  rows.tenants[0].telephonyType = "SIP_TRUNK";
  rows.sip_trunk_configs = [{ id: 1, tenantId: 1, isEnabled: true, sipDomain: "sip.dialog.test", sipUsername: "fake-user", phoneNumber: "+15550000004", sipPassword: legacyCbc(SIP_PASSWORD) }];
  let context: any = await resolveTelephonyForUser(10, "+15550009999");
  assert.equal(context.sipAuthPassword, SIP_PASSWORD);
  rows.sip_trunk_configs[0].sipPassword = sealCredential("sipPassword", 1, SIP_PASSWORD);
  context = await resolveTelephonyForUser(10, "+15550009999");
  assert.deepEqual([context.sipAuthPassword, context.twilioAuthToken], [SIP_PASSWORD, TOKEN_A]);

  rows.tenants[0].telephonyType = "EXOTEL";
  rows.exotel_configs = [
    { id: 1, tenantId: 1, isEnabled: true, accountSid: "fake", exophone: "+15550000003", region: "mumbai", appFlowUrl: "https://dialog.test/flow",
      apiKey: legacyCbc(EXOTEL_KEY), apiToken: sealCredential("exotelApiToken", 1, EXOTEL_TOKEN) },
  ];
  context = await resolveTelephonyForUser(10, "+15550009999");
  assert.deepEqual([context.credentials.apiKey, context.credentials.apiToken], [EXOTEL_KEY, EXOTEL_TOKEN]);
  rows.exotel_configs[0].apiKey = "fake-plaintext-in-cbc-column";
  await assert.rejects(resolveTelephonyForUser(10, "+15550009999"), { message: "Failed to decrypt Exotel credentials." });
  assert.equal(logs.find((l) => l.event === "credential_unavailable")?.reason, "format");
  assertNoLeak(["fake-plaintext-in-cbc-column"]);
});

// ── CRM lookups and webhooks ───────────────────────────────────────────

const crmConfig = (userId: number, authValue: string | null) => ({
  id: userId, userId, name: "Fake CRM", isEnabled: true, lookupUrl: `${crmBase}/lookup`, httpMethod: "GET",
  authType: "bearer", authValue, authHeaderName: null, phoneParamName: "phone", phoneParamLocation: "query",
  responseMapping: { customerName: "customer.name" }, useRawResponse: false, maxContextChars: 2000,
  timeoutMs: 2000, cacheTtlSeconds: 0, widgetChatSyncEnabled: false, widgetChatWebhookUrl: null,
});

test("CRM lookups send the decrypted value and never send a request with an unusable credential", async () => {
  rows.external_crm_configs = [crmConfig(10, sealCredential("crmAuthValue", 10, CRM_AUTH))];
  invalidateExternalCrmConfigCache(10);
  assert.equal((await fetchExternalCrmData(10, "+15550100777"))?.customerName, "Synthetic Customer");
  assert.deepEqual(hits.map((h) => h.authorization), [`Bearer ${CRM_AUTH}`]);

  // Tenant 20 holding tenant 10's ciphertext: no request leaves the process.
  rows.external_crm_configs = [crmConfig(20, rows.external_crm_configs[0].authValue)];
  invalidateExternalCrmConfigCache(20);
  assert.equal(await fetchExternalCrmData(20, "+15550100777"), null);
  assert.deepEqual(await testExternalCrmLookup(20, "+15550100777"), {
    success: false,
    error: "Stored CRM credential could not be decrypted; re-enter it to continue",
  });
  assert.equal(hits.length, 1, "no unauthenticated request was sent");
  assert.ok(logs.some((l) => l.event === "credential_unavailable" && l.reason === "authentication"));
  assertNoLeak();
});

test("CRM webhooks are signed with the decrypted secret; an unusable secret blocks delivery", async () => {
  rows.tenants = [{ id: 1, ownerId: 10, status: "active" }];
  rows.crm_api_keys = [
    { id: 1, userId: 10, tenantId: 1, isActive: true, webhookUrl: `${crmBase}/hook-v1`, webhookSecret: sealCredential("crmWebhookSecret", 10, WEBHOOK_SECRET) },
    { id: 2, userId: 10, tenantId: 1, isActive: true, webhookUrl: `${crmBase}/hook-legacy`, webhookSecret: WEBHOOK_SECRET },
    { id: 3, userId: 10, tenantId: 1, isActive: true, webhookUrl: `${crmBase}/hook-foreign`, webhookSecret: sealCredential("crmWebhookSecret", 20, WEBHOOK_SECRET) },
  ];
  rows.webhook_deliveries = [];
  startWebhookDispatcher();
  crmEventBus.emitCallEvent({ type: "call.turn", callId: 1, userId: 10, callSid: "CA" + "f".repeat(32), data: { role: "user", content: "synthetic" }, timestamp: new Date().toISOString() } as any);
  for (let i = 0; i < 200 && rows.webhook_deliveries.filter((d: any) => d.attempts === 1).length < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  for (const path of ["/hook-v1", "/hook-legacy"]) {
    const hit = hits.find((h) => h.path === path)!;
    assert.equal(hit.signature, signWebhookPayload(hit.body, WEBHOOK_SECRET), path);
  }
  assert.equal(hits.some((h) => h.path === "/hook-foreign"), false);
  const foreign = rows.webhook_deliveries.find((d: any) => d.apiKeyId === 3);
  assert.equal(foreign.responseBody, "Delivery failed: signing secret unavailable");
  assertNoLeak();
});

// ── API responses and write paths ──────────────────────────────────────

async function app(t: any, principal: { userId?: number; isSuperadmin?: boolean } = {}) {
  const server = express();
  server.use(express.json());
  server.use("/api", crmRouter);
  server.use("/api", (req: any, _res: any, next: any) => {
    req.userId = principal.userId;
    req.isSuperadmin = principal.isSuperadmin === true;
    next();
  }, agentsRouter, externalCrmRouter, adminRouter);
  const listener = createServer(server).listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => {
    listener.closeAllConnections();
    listener.close();
  });
  const base = `http://127.0.0.1:${(listener.address() as any).port}/api`;
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
}

test("agent and admin endpoints store v1 and never return stored credentials, even to superadmins", async (t) => {
  seedTenants();
  rows.agent_configs[0].telephonyApiKey = sealCredential("telephonyApiKey", 10, "fake-byoc-key");
  const send = await app(t, { userId: 10, isSuperadmin: true });

  const got = await send("GET", "/agents");
  assert.equal(got.status, 200);
  assert.equal(got.json.twilioAuthToken, "***");
  assert.equal(got.json.telephonyApiKey, "***configured***");
  assert.equal(got.json.twilioConfigured, true);
  assert.ok(!got.text.includes(TOKEN_A) && !got.text.includes("enc:v1"), "response exposes a stored credential");

  const saved = await send("PUT", "/agents", { twilioAuthToken: "fake-new-token", telephonyApiSecret: "fake-new-secret" });
  assert.equal(saved.status, 200);
  assert.ok(!saved.text.includes("fake-new-token") && !saved.text.includes("enc:v1"));
  assert.equal(openCredential("twilioAuthToken", 10, rows.agent_configs[0].twilioAuthToken), "fake-new-token");
  assert.equal(openCredential("telephonyApiSecret", 10, rows.agent_configs[0].telephonyApiSecret), "fake-new-secret");
  const unchanged = rows.agent_configs[0].twilioAuthToken;
  await send("PUT", "/agents", { twilioAuthToken: "***" });
  assert.equal(rows.agent_configs[0].twilioAuthToken, unchanged, "the mask never overwrites a stored value");

  await send("PUT", "/superadmin/tenants/2/telephony", { twilioAuthToken: "fake-admin-token" });
  assert.equal(openCredential("twilioAuthToken", 20, rows.agent_configs[1].twilioAuthToken), "fake-admin-token");
  await send("POST", "/superadmin/tenants/1/telephony/sip-trunk", { sipDomain: "sip.dialog.test", sipUsername: "u", sipPassword: SIP_PASSWORD, phoneNumber: "+15550000004" });
  assert.equal(openCredential("sipPassword", 1, rows.sip_trunk_configs[0].sipPassword), SIP_PASSWORD);
  const sip = await send("GET", "/superadmin/tenants/1/telephony/sip-trunk");
  assert.equal(sip.json.sipPassword, "***configured***");
  await send("POST", "/superadmin/tenants/1/telephony/exotel", { accountSid: "fake", exophone: "+15550000003", appFlowUrl: "https://dialog.test/flow", apiKey: EXOTEL_KEY, apiToken: EXOTEL_TOKEN });
  assert.equal(openCredential("exotelApiKey", 1, rows.exotel_configs[0].apiKey), EXOTEL_KEY);
  assert.equal(openCredential("exotelApiToken", 1, rows.exotel_configs[0].apiToken), EXOTEL_TOKEN);

  const tenantUser = await app(t, { userId: 10, isSuperadmin: false });
  assert.equal((await tenantUser("PUT", "/agents", { twilioAuthToken: "fake-tenant-token" })).status, 403);
  assertNoLeak(["fake-new-token", "fake-new-secret", "fake-admin-token", "fake-byoc-key"]);
});

test("external CRM config and CRM webhook registration store v1 and keep their response contracts", async (t) => {
  const key = "dk_live_" + "c".repeat(64);
  rows.tenants = [{ id: 1, ownerId: 10, status: "active" }];
  rows.crm_api_keys = [{ id: 1, keyHash: createHash("sha256").update(key).digest("hex"), userId: 10, tenantId: 1, scopes: ["*"], isActive: true, webhookSecret: WEBHOOK_SECRET }];
  rows.external_crm_configs = [];
  const send = await app(t, { userId: 10 });

  const created = await send("PUT", "/external-crm/config", { name: "CRM", lookupUrl: "https://crm.example.com/lookup", authValue: CRM_AUTH });
  assert.equal(created.status, 201);
  assert.equal(created.json.config.authValue, "***configured***");
  assert.equal(openCredential("crmAuthValue", 10, rows.external_crm_configs[0].authValue), CRM_AUTH);
  const read = await send("GET", "/external-crm/config");
  assert.equal(read.json.config.authValue, "***configured***");
  for (const res of [created, read]) assert.ok(!res.text.includes(CRM_AUTH) && !res.text.includes("enc:v1"));

  // The authorized key holder still receives the same signing secret; storage is now v1.
  const auth = { Authorization: `Bearer ${key}` };
  const registered = await send("POST", "/crm/webhooks", { webhookUrl: "https://hooks.example.com/dialog" }, auth);
  assert.equal(registered.status, 200);
  assert.equal(registered.json.webhookSecret, WEBHOOK_SECRET);
  assert.equal(openCredential("crmWebhookSecret", 10, rows.crm_api_keys[0].webhookSecret), WEBHOOK_SECRET);
  const again = await send("POST", "/crm/webhooks", { webhookUrl: "https://hooks.example.com/dialog" }, auth);
  assert.equal(again.json.webhookSecret, WEBHOOK_SECRET, "re-registration keeps the existing secret");

  // An undecryptable stored secret is not silently replaced.
  const broken = withSegment(rows.crm_api_keys[0].webhookSecret, 5, flipFirst);
  rows.crm_api_keys[0].webhookSecret = broken;
  const failed = await send("POST", "/crm/webhooks", { webhookUrl: "https://hooks.example.com/dialog" }, auth);
  assert.equal(failed.status, 500);
  assert.equal(failed.json.error, "Webhook signing secret is unavailable");
  assert.equal(rows.crm_api_keys[0].webhookSecret, broken);
  assertNoLeak([key]);
});
