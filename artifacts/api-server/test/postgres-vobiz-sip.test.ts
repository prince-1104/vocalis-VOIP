import { test } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../lib/db/src/schema";
import { applyMigrations, inspectSchema } from "@workspace/db/migrations";
import { createVobizConfigurationService } from "../src/lib/telephony/vobiz-configuration";
import { credentialCodec } from "../src/lib/credential-crypto";
import { configured, directory, migrateThrough, withDatabase } from "./pg-databases";

const skip = !configured && "TEST_DATABASE_URL not supplied; isolated PostgreSQL unavailable";
const input = { sipDomain: "fixture-a.sip.vobiz.ai", sipUsername: "fake-vobiz-pg-user", sipPassword: "fake-vobiz-pg-password", phoneNumbers: ["+15550100001"] };
const scope = { tenantId: 1, ownerId: 10, tenantUserId: 100, superadmin: false };
async function seed(c: any) {
  await c.query(`insert into users(id,email) values (10,'owner-a@example.test'),(20,'owner-b@example.test');
    insert into tenants(id,name,slug,owner_id) values (1,'A','a',10),(2,'B','b',20)`);
}

test("PostgreSQL: Vobiz migration upgrades 0009 additively, gates readiness and preserves Twilio data", { skip }, async t => {
  await withDatabase(t, async connect => {
    const c = await connect(); await migrateThrough(c, "0009_schema_reconciliation"); await seed(c);
    await c.query(`insert into sip_trunk_configs(tenant_id,sip_domain,sip_username,sip_password,phone_number) values (1,'sip.fixture.test','fake-user','fake-legacy-value','+15550100009')`);
    assert.deepEqual((await inspectSchema(c)).pending, ["0010_vobiz_sip_configuration", "0011_livekit_sessions"]);
    assert.deepEqual(await applyMigrations(c, directory), ["0010_vobiz_sip_configuration", "0011_livekit_sessions"]);
    assert.deepEqual(await applyMigrations(c, directory), []); assert.equal((await inspectSchema(c)).status, "ready");
    assert.deepEqual((await c.query(`select telephony_type from tenants order by id`)).rows, [{ telephony_type: "TWILIO" }, { telephony_type: "TWILIO" }]);
    assert.equal((await c.query(`select sip_password from sip_trunk_configs where tenant_id=1`)).rows[0].sip_password, "fake-legacy-value");
    const service = createVobizConfigurationService(drizzle(c, { schema }) as any);
    await service.put(scope, input);
    const row = (await c.query(`select * from vobiz_sip_configs`)).rows[0];
    assert.match(row.sip_username, /^enc:v1:/); assert.match(row.sip_password, /^enc:v1:/);
    assert.equal(credentialCodec().open("vobizSipPassword", 1, row.sip_password), input.sipPassword);
    await assert.rejects(c.query(`insert into vobiz_sip_configs(tenant_id,sip_domain,sip_username,sip_password,phone_numbers) select tenant_id,sip_domain,sip_username,sip_password,phone_numbers from vobiz_sip_configs`), (error: any) => error.code === "23505");
    await assert.rejects(c.query(`insert into vobiz_sip_configs(tenant_id,sip_domain,sip_username,sip_password,phone_numbers) select 999,sip_domain,sip_username,sip_password,phone_numbers from vobiz_sip_configs`), (error: any) => error.code === "23503");
    await c.query(`delete from tenants where id=1`);
    assert.equal((await c.query(`select count(*)::int as n from vobiz_sip_configs`)).rows[0].n, 0);
  });
});

test("PostgreSQL: independent Vobiz config updates are complete, unique and tenant scoped", { skip }, async t => {
  await withDatabase(t, async connect => {
    const a = await connect(), b = await connect(); await applyMigrations(a, directory); await seed(a);
    const one = createVobizConfigurationService(drizzle(a, { schema }) as any), two = createVobizConfigurationService(drizzle(b, { schema }) as any);
    const other = { ...input, sipDomain: "fixture-b.sip.vobiz.ai", sipUsername: "fake-vobiz-pg-user-b", sipPassword: "fake-vobiz-pg-password-b", phoneNumbers: ["+15550100002"] };
    await Promise.all([one.put(scope, input), two.put(scope, other)]);
    const { rows } = await a.query(`select * from vobiz_sip_configs`); assert.equal(rows.length, 1);
    const expected = rows[0].sip_domain === input.sipDomain ? input : other;
    assert.equal(credentialCodec().open("vobizSipUsername", 1, rows[0].sip_username), expected.sipUsername);
    assert.equal(credentialCodec().open("vobizSipPassword", 1, rows[0].sip_password), expected.sipPassword);
    assert.deepEqual(rows[0].phone_numbers, expected.phoneNumbers);
    assert.equal((await two.get({ ...scope, tenantId: 2, ownerId: 20 })).state, "not_configured");
    await assert.rejects(two.put({ ...scope, ownerId: 20 }, other), (error: any) => error.status === 404);
    assert.deepEqual((await a.query(`select telephony_type from tenants order by id`)).rows, [{ telephony_type: "TWILIO" }, { telephony_type: "TWILIO" }]);
  });
});
