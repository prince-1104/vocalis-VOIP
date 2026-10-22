import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import express from "express";
import { rows, db, writes, resetDatabase, vobizSipInputSchema } from "./fake-db";
import { emitted, logger, resetLogs } from "./capture-logger";
import { resolveUser, signToken, generateSessionId } from "../src/middleware/auth";
import { createHttpLogger } from "../src/lib/http-logger";
import { createVobizSipRouter } from "../src/routes/vobiz-sip";
import { createVobizConfigurationService } from "../src/lib/telephony/vobiz-configuration";
import { credentialCodec, createCredentialCodec, parseKeyring, openCredential, sealCredential, CredentialError } from "../src/lib/credential-crypto";
import { migrateCredentials } from "../src/lib/credential-migration";
import { resolveTelephonyForUser, TelephonyUnavailableError } from "../src/lib/telephony/resolve-telephony";
import { placeOutboundCall } from "../src/lib/telephony/place-outbound-call";
import { executeTransfer } from "../src/lib/transfer-manager";
import { activeTwilioTenantId } from "../src/lib/twilio-webhook-auth";
import { mediaSessionStore } from "../src/lib/media-session";
import { readFile } from "node:fs/promises";

after(() => { for (const timer of (globalThis as any).__dialogTestIntervals) clearInterval(timer); });

const input = {
  sipDomain: "fixture-a.sip.vobiz.ai", sipUsername: "fake-vobiz-sip-user-a",
  sipPassword: "fake-vobiz-sip-password-for-tests", phoneNumbers: ["+15550100001"],
};
const scope = (tenantId = 1) => ({ tenantId, ownerId: tenantId * 10, tenantUserId: tenantId * 100, superadmin: false });
let bearers: Record<number, string>;

beforeEach(() => {
  resetDatabase(); resetLogs();
  rows.users = [{ id: 10, isSuperadmin: false }, { id: 20, isSuperadmin: false }, { id: 90, isSuperadmin: true }];
  rows.tenants = [1, 2, 9].map(id => ({ id, ownerId: id * 10, status: "active", telephonyType: "TWILIO" }));
  rows.tenant_users = [
    { id: 100, tenantId: 1, userId: 10, role: "admin", isActive: true },
    { id: 200, tenantId: 2, userId: 20, role: "admin", isActive: true },
    { id: 900, tenantId: 9, userId: 90, role: "manager", isActive: true },
    { id: 101, tenantId: 1, userId: null, role: "manager", isActive: true },
    { id: 102, tenantId: 1, userId: null, role: "admin", isActive: true },
  ];
  bearers = {};
  rows.tenant_sessions = rows.tenant_users.map(member => {
    const jti = generateSessionId(); bearers[member.id] = "Bearer " + signToken({ tenantUserId: member.id, jti });
    return { token: jti, tenantUserId: member.id, tenantId: member.tenantId, expiresAt: new Date(Date.now() + 60_000), revokedAt: null };
  });
  rows.agent_configs = [{ userId: 10, twilioAccountSid: "AC" + "a".repeat(32), twilioAuthToken: sealCredential("twilioAuthToken", 10, "fake-twilio-provider-token"), phoneNumber: "+15550100009" }];
});

async function harness(t: any, service = createVobizConfigurationService()) {
  const app = express(); app.use(createHttpLogger()); app.use(express.json()); app.use(resolveUser); app.use("/api", createVobizSipRouter(service));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  return async (member: number | null, method = "GET", path = "/telephony/vobiz-sip", body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { ...(member ? { authorization: bearers[member] } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  };
}

test("Vobiz contract validates trunk-specific domains, bounded credentials and canonical unique E.164 numbers", () => {
  assert.equal(vobizSipInputSchema.parse({ ...input, sipDomain: input.sipDomain.toUpperCase() }).sipDomain, input.sipDomain);
  for (const sipDomain of ["sip.vobiz.ai", "sip:" + input.sipDomain, "https://" + input.sipDomain, input.sipDomain + ":5060", "user@" + input.sipDomain, input.sipDomain + ".other.test", "-fixture.sip.vobiz.ai", "a.b.sip.vobiz.ai", "127.0.0.1"])
    assert.equal(vobizSipInputSchema.safeParse({ ...input, sipDomain }).success, false);
  for (const phoneNumbers of [[], ["15550100001"], ["+1 5550100001"], ["+0123"], ["+" + "1".repeat(16)], [input.phoneNumbers[0], input.phoneNumbers[0]], Array.from({ length: 101 }, (_, i) => `+155501${String(i).padStart(5, "0")}`)])
    assert.equal(vobizSipInputSchema.safeParse({ ...input, phoneNumbers }).success, false);
  for (const extra of [{ sipUsername: "" }, { sipPassword: "" }, { sipPassword: " \n" }, { sipUsername: "x".repeat(257) }, { sipPassword: "x".repeat(4097) }, { isEnabled: true }, { state: "connected" }, { inboundDestination: "unverified.test" }, { apiToken: "fake-account-token" }])
    assert.equal(vobizSipInputSchema.safeParse({ ...input, ...extra }).success, false);
});

test("real authenticated routes save encrypted fields and expose only unverified metadata without selecting a provider", async (t) => {
  const send = await harness(t);
  assert.equal((await send(100)).body.state, "not_configured");
  const response = await send(100, "PUT", undefined, input);
  assert.equal(response.status, 200); assert.equal(response.body.state, "configured_unverified");
  assert.equal(response.body.executionAvailable, false); assert.equal(response.body.requiredIntegration, "livekit"); assert.equal(response.body.inboundDestination, null);
  assert.deepEqual(response.body.phoneNumbers, input.phoneNumbers); assert.equal(response.headers.get("cache-control"), "no-store");
  const stored = rows.vobiz_sip_configs[0];
  for (const [property, field] of [["sipUsername", "vobizSipUsername"], ["sipPassword", "vobizSipPassword"]] as const) {
    assert.match(stored[property], /^enc:v1:/); assert.equal(openCredential(field, 1, stored[property]), input[property]);
    assert.ok(!JSON.stringify(response.body).includes(stored[property])); assert.ok(!JSON.stringify(response.body).includes(input[property]));
  }
  assert.deepEqual((await send(100)).body, response.body);
  assert.equal(rows.tenants[0].telephonyType, "TWILIO"); assert.equal(rows.call_logs?.length ?? 0, 0); assert.equal(rows.budget_reservations?.length ?? 0, 0);
});

test("tenant admins cannot read, update or delete another tenant's Vobiz configuration", async (t) => {
  const send = await harness(t); await send(100, "PUT", undefined, input);
  const before = JSON.stringify(rows.vobiz_sip_configs);
  assert.equal((await send(200)).body.state, "not_configured");
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await send(200, method, "/superadmin/tenants/1/telephony/vobiz-sip", method === "PUT" ? input : undefined)).status, 403);
  assert.equal((await send(200, "PUT", undefined, { ...input, tenantId: 1, ownerId: 10 })).status, 400);
  assert.equal((await send(200, "GET", "/telephony/vobiz-sip?tenantId=1&userId=10")).body.state, "not_configured");
  assert.equal(JSON.stringify(rows.vobiz_sip_configs), before);
});

test("principal-based superadmin manages an explicit target; malformed target IDs and missing tenants fail generically", async (t) => {
  const send = await harness(t);
  const path = "/superadmin/tenants/2/telephony/vobiz-sip";
  assert.equal((await send(900, "PUT", path, input)).status, 200);
  assert.equal(rows.vobiz_sip_configs[0].tenantId, 2); assert.equal(openCredential("vobizSipPassword", 2, rows.vobiz_sip_configs[0].sipPassword), input.sipPassword);
  assert.equal((await send(900, "GET", path)).body.state, "configured_unverified");
  assert.equal((await send(900)).body.state, "not_configured");
  for (const id of ["0", "01", "2junk", "2147483648", "9007199254740993", "999"]) {
    const response = await send(900, "GET", `/superadmin/tenants/${id}/telephony/vobiz-sip`);
    assert.equal(response.status, 404); assert.deepEqual(response.body, { error: "Vobiz configuration not found" });
  }
});

test("anonymous, managers, revoked memberships and suspended tenants cannot mutate configuration", async (t) => {
  const send = await harness(t);
  for (const method of ["GET", "PUT", "DELETE"]) {
    assert.equal((await send(null, method, undefined, method === "PUT" ? input : undefined)).status, 401);
    assert.equal((await send(101, method, undefined, method === "PUT" ? input : undefined)).status, 403);
  }
  rows.tenant_users.find(member => member.id === 100)!.isActive = false;
  assert.equal((await send(100, "PUT", undefined, input)).status, 401);
  rows.tenants[1].status = "suspended";
  assert.equal((await send(200, "PUT", undefined, input)).status, 402);
  assert.equal((await send(900, "PUT", "/superadmin/tenants/2/telephony/vobiz-sip", input)).status, 403);
  assert.equal(writes, 0);
});

test("null-linked admins have tenant access without owner-derived platform privilege", async (t) => {
  rows.users[0].isSuperadmin = true;
  const send = await harness(t);
  assert.equal((await send(102, "PUT", undefined, input)).status, 200);
  assert.equal((await send(102, "GET", "/superadmin/tenants/2/telephony/vobiz-sip")).status, 403);
});

test("complete atomic replacements reject partial updates and delete without changing Twilio selection", async (t) => {
  const send = await harness(t); await send(100, "PUT", undefined, input);
  const previous = rows.vobiz_sip_configs[0].sipPassword;
  assert.equal((await send(100, "PUT", undefined, { sipDomain: input.sipDomain })).status, 400);
  assert.equal(rows.vobiz_sip_configs[0].sipPassword, previous);
  const replacement = { ...input, sipUsername: "fake-replacement-user", sipPassword: "fake-replacement-password" };
  await send(100, "PUT", undefined, replacement);
  assert.equal(rows.vobiz_sip_configs.length, 1); assert.notEqual(rows.vobiz_sip_configs[0].sipPassword, previous);
  assert.equal(openCredential("vobizSipUsername", 1, rows.vobiz_sip_configs[0].sipUsername), replacement.sipUsername);
  assert.equal((await send(100, "DELETE")).body.state, "not_configured");
  assert.equal((await send(100, "DELETE")).status, 200); assert.equal(rows.tenants[0].telephonyType, "TWILIO");
});

test("new credentials reject plaintext, tenant/field swaps and retired keys without legacy fallback", async () => {
  const codec = credentialCodec(); const encrypted = codec.seal("vobizSipUsername", 1, input.sipUsername);
  for (const field of ["vobizSipUsername", "vobizSipPassword"] as const) assert.throws(() => codec.open(field, 1, input.sipPassword), CredentialError);
  assert.throws(() => codec.open("vobizSipUsername", 2, encrypted), CredentialError);
  assert.throws(() => codec.open("vobizSipPassword", 1, encrypted), CredentialError);
  const unrelated = createCredentialCodec({ activeKeyId: "other", keys: new Map([["other", randomBytes(32)]]), legacyReads: true, legacyCbcKey: null });
  assert.throws(() => unrelated.open("vobizSipUsername", 1, encrypted), CredentialError);
});

test("Vobiz fields participate in the existing compare-and-set rotation tooling", async () => {
  await createVobizConfigurationService().put(scope(), input);
  const keyring = parseKeyring(process.env);
  const next = createCredentialCodec({ ...keyring, activeKeyId: "next", keys: new Map([...keyring.keys, ["next", randomBytes(32)]]) });
  const result = await migrateCredentials(db, next, { apply: true });
  for (const field of ["vobizSipUsername", "vobizSipPassword"] as const) assert.equal(result.columns.find(column => column.field === field)!.reencrypted, 1);
  const stored = rows.vobiz_sip_configs[0];
  assert.equal(next.open("vobizSipUsername", 1, stored.sipUsername), input.sipUsername); assert.equal(next.open("vobizSipPassword", 1, stored.sipPassword), input.sipPassword);
  assert.equal((await createVobizConfigurationService(db, () => next).get(scope())).state, "configured_unverified");
});

test("missing encryption configuration fails safely before any configuration write", async (t) => {
  const getCodec = () => createCredentialCodec(parseKeyring({}));
  const send = await harness(t, createVobizConfigurationService(db, getCodec));
  const response = await send(100, "PUT", undefined, input);
  assert.equal(response.status, 503); assert.deepEqual(response.body, { error: "Vobiz configuration unavailable" }); assert.equal(writes, 0);
  await createVobizConfigurationService().put(scope(), input);
  assert.equal((await send(100)).status, 503);
  assert.ok(!emitted().includes(input.sipUsername)); assert.ok(!emitted().includes(input.sipPassword));
});

test("corrupt or partial persisted configurations return generic unavailable responses", async (t) => {
  const send = await harness(t); await send(100, "PUT", undefined, input);
  const good = { ...rows.vobiz_sip_configs[0] };
  for (const change of [{ sipPassword: "" }, { sipUsername: input.sipUsername }, { sipPassword: good.sipUsername }, { phoneNumbers: [] }, { sipDomain: "sip.vobiz.ai" }]) {
    rows.vobiz_sip_configs[0] = { ...good, ...change };
    const response = await send(100); assert.equal(response.status, 503); assert.deepEqual(response.body, { error: "Vobiz configuration unavailable" });
  }
});

test("database exception details and input credentials never reach responses or audit logs", async (t) => {
  const badConnection = { ...db, insert: () => { throw new Error(JSON.stringify(input)); } };
  const send = await harness(t, createVobizConfigurationService(badConnection));
  const response = await send(100, "PUT", undefined, input);
  assert.equal(response.status, 503); assert.deepEqual(response.body, { error: "Vobiz configuration unavailable" });
  logger.error({ sipUsername: input.sipUsername, vobizSipUsername: input.sipUsername, sipPassword: input.sipPassword }, "Credential fixture");
  for (const value of [input.sipUsername, input.sipPassword, input.phoneNumbers[0], input.sipDomain]) assert.ok(!emitted().includes(value));
});

test("saving Vobiz configuration leaves both Twilio and legacy Twilio SIP provider resolution unchanged", async () => {
  const before = await resolveTelephonyForUser(10, input.phoneNumbers[0]);
  await createVobizConfigurationService().put(scope(), input);
  assert.deepEqual(await resolveTelephonyForUser(10, input.phoneNumbers[0]), before); assert.equal(before.provider, "TWILIO");
  rows.tenants[0].telephonyType = "SIP_TRUNK";
  rows.sip_trunk_configs = [{ tenantId: 1, isEnabled: true, sipDomain: "sip.fixture.test", sipUsername: "fake-legacy-user", sipPassword: sealCredential("sipPassword", 1, "fake-legacy-password"), phoneNumber: "+15550100009" }];
  const legacy = await resolveTelephonyForUser(10, input.phoneNumbers[0]);
  assert.equal(legacy.provider, "SIP_TRUNK"); assert.equal(legacy.provider !== "EXOTEL" && legacy.toPhone, `sip:${input.phoneNumbers[0]}@sip.fixture.test`);
});

test("unsupported Vobiz selection refuses outbound execution before call state, reservations or provider work", async () => {
  rows.tenants[0].telephonyType = "VOBIZ_SIP";
  const assertUnavailable = (err: unknown) => err instanceof TelephonyUnavailableError && err.code === "livekit_required";
  await assert.rejects(resolveTelephonyForUser(10, input.phoneNumbers[0]), assertUnavailable);
  await assert.rejects(placeOutboundCall({ userId: 10, phone: input.phoneNumbers[0], baseUrl: "https://dialog.test" }), assertUnavailable);
  assert.equal(writes, 0); assert.equal(rows.call_logs?.length ?? 0, 0); assert.equal(rows.budget_reservations?.length ?? 0, 0);
});

test("Vobiz selection cannot enter Twilio signature/media or transfer adapters", async () => {
  rows.tenants[0].telephonyType = "VOBIZ_SIP";
  const agent = rows.agent_configs[0]; assert.equal(await activeTwilioTenantId(agent), null);
  rows.call_logs = [{ id: 1, userId: 10, callSid: "CA" + "b".repeat(32), endedAt: null }];
  assert.equal(await mediaSessionStore.binding(1), null);
  const result = await executeTransfer(10, { callId: 1, callSid: rows.call_logs[0].callSid, reason: "test" } as any);
  assert.equal(result.success, false); assert.match(result.error!, /LiveKit/); assert.equal(writes, 0);
});

test("actual app mounts Vobiz settings after identity resolution with no new activation route", async () => {
  const app = await readFile("src/app.ts", "utf8");
  assert.ok(app.indexOf('app.use("/api", resolveUser)') < app.indexOf('app.use("/api", createVobizSipRouter())'));
  const router = await readFile("src/routes/vobiz-sip.ts", "utf8");
  assert.ok(!router.includes('router.post(')); assert.ok(!router.includes('router.patch('));
});

import "./postgres-vobiz-sip.test";
