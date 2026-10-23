import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adoptExistingDatabase,
  applyMigrations,
  inspectSchema,
  MIGRATION_JOURNAL,
  MigrationError,
} from "@workspace/db/migrations";
import { runStartup, StartupBlockedError, waitForCompatibleSchema } from "../src/lib/schema-readiness";

import { configured, directory, migrateThrough, pgRequire, rawApply, withDatabase } from "./pg-databases";

const tags = MIGRATION_JOURNAL.map((m) => m.tag);
const throughBaseline = tags.slice(0, tags.indexOf("0009_schema_reconciliation"));
const count = async (c: any, sql: string) => Number((await c.query(sql)).rows[0].n);
const historyCount = (c: any) => count(c, `select count(*) n from drizzle.__drizzle_migrations`);

async function seed(c: any) {
  await c.query(`insert into users (id, email) values (10, 'owner@example.test'), (20, 'other@example.test');
    insert into tenants (id, name, slug, owner_id, commission_pct) values (1, 'Tenant A', 'a', 10, 20), (2, 'Tenant B', 'b', 20, 0);
    insert into tenant_users (tenant_id, email) values (1, 'agent@example.test');
    insert into tenant_limits (tenant_id, monthly_limit_usd, hard_limit) values (1, 12.50, true);
    insert into billing_rate_cards (version, rates, source) values ('v-test', '{"llm":{}}', 'test');
    insert into usage_ledger (tenant_id, user_id, source, category, provider, model, idempotency_key, measurement, unit, status, event_at)
      values (1, 10, 'test', 'llm', 'openai', 'm', 'k-1', 'unknown', 'tokens', 'pending', now());
    insert into invoices (tenant_id, period) values (1, '2026-09');`);
}

async function assertSeedIntact(c: any) {
  const tenants = (await c.query(`select id, name, commission_pct::text, telephony_type from tenants order by id`)).rows;
  assert.deepEqual(tenants, [
    { id: 1, name: "Tenant A", commission_pct: "20.00", telephony_type: "TWILIO" },
    { id: 2, name: "Tenant B", commission_pct: "0.00", telephony_type: "TWILIO" },
  ]);
  assert.equal((await c.query(`select monthly_limit_usd::text v from tenant_limits where tenant_id = 1`)).rows[0].v, "12.50");
  assert.equal(await count(c, `select count(*) n from usage_ledger where idempotency_key = 'k-1' and currency = 'USD'`), 1);
  assert.equal(await count(c, `select count(*) n from invoices`), 1);
  assert.equal(await count(c, `select count(*) n from tenant_users`), 1);
  await assert.rejects(c.query(`update billing_rate_cards set source = 'x'`), /immutable/);
}

const skip = !configured && "TEST_DATABASE_URL not supplied; isolated PostgreSQL unavailable";

test("PostgreSQL: fresh install from migrations alone is complete, repeatable and serialized", { skip }, async (t) => {
  await withDatabase(t, async (connect) => {
    const [a, b] = [await connect(), await connect()];
    // Two deployers at once: the advisory lock lets exactly one apply each migration.
    const results = await Promise.all([applyMigrations(a, directory), applyMigrations(b, directory)]);
    assert.deepEqual([...results[0], ...results[1]].sort(), [...tags].sort());
    assert.equal(await historyCount(a), tags.length);
    assert.deepEqual(await applyMigrations(a, directory), [], "second run is a no-op");
    const report = await inspectSchema(a);
    assert.deepEqual(report, { status: "ready", pending: [], newerThanCode: 0, missing: [] });
    const column = (await a.query(`select data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'tenants' and column_name = 'telephony_type'`)).rows[0];
    assert.deepEqual(column, { data_type: "text", is_nullable: "NO", column_default: "'TWILIO'::text" });
    const checks = (await a.query(`select conname from pg_constraint
      where contype = 'c' and convalidated and conrelid in
        ('usage_ledger'::regclass, 'budget_reservations'::regclass, 'tenant_budget_periods'::regclass)
      order by conname`)).rows.map((r: any) => r.conname);
    assert.deepEqual(checks, [
      "budget_reservations_amount_check",
      "budget_reservations_status_check",
      "tenant_budget_periods_reserved_check",
      "usage_ledger_category_check",
      "usage_ledger_currency_check",
      "usage_ledger_entry_type_check",
      "usage_ledger_measurement_check",
      "usage_ledger_priced_check",
      "usage_ledger_status_check",
    ]);
    // Re-running 0009's statements directly is harmless too.
    await rawApply(a, ["0009_schema_reconciliation"]);
    assert.deepEqual((await inspectSchema(a)).status, "ready");
    await seed(a);
    await assertSeedIntact(a);
  });
});

test("PostgreSQL: upgrade from 0008 with data; startup refuses until 0009 is applied", { skip }, async (t) => {
  await withDatabase(t, async (connect) => {
    const c = await connect();
    await migrateThrough(c, "0008_usage_ledger_and_budgets");
    await seed(c);

    const before = await inspectSchema(c);
    assert.equal(before.status, "migrations_pending");
    assert.deepEqual(before.pending, ["0009_schema_reconciliation", "0010_vobiz_sip_configuration", "0011_livekit_sessions"]);
    assert.ok(before.missing.includes("column tenants.telephony_type"));
    const events: string[] = [];
    await assert.rejects(
      runStartup({
        checkSchema: () => waitForCompatibleSchema(c),
        prepare: async () => { events.push("prepare"); },
        listen: async () => { events.push("listen"); },
        startWorkers: () => { events.push("workers"); },
        markReady: () => { events.push("ready"); },
      }),
      (err: unknown) =>
        err instanceof StartupBlockedError && err.reason === "migrations_pending" && err.details[0] === "0009_schema_reconciliation",
    );
    assert.deepEqual(events, []);

    assert.deepEqual(await applyMigrations(c, directory), ["0009_schema_reconciliation", "0010_vobiz_sip_configuration", "0011_livekit_sessions"]);
    await assertSeedIntact(c);
    assert.equal((await inspectSchema(c)).status, "ready");
    await waitForCompatibleSchema(c);
  });
});

// The four tables as the former startup db-sync created them (default *_key/*_fkey names).
const LEGACY_DB_SYNC = `
  CREATE TABLE IF NOT EXISTS "exotel_configs" ("id" serial PRIMARY KEY NOT NULL, "tenant_id" integer NOT NULL UNIQUE REFERENCES "tenants"("id") ON DELETE CASCADE,
    "account_sid" text NOT NULL, "api_key" text NOT NULL, "api_token" text NOT NULL, "exophone" text NOT NULL, "region" text DEFAULT 'singapore' NOT NULL,
    "app_flow_url" text NOT NULL, "is_enabled" boolean DEFAULT false NOT NULL, "created_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL);
  CREATE TABLE IF NOT EXISTS "sip_trunk_configs" ("id" serial PRIMARY KEY NOT NULL, "tenant_id" integer NOT NULL UNIQUE REFERENCES "tenants"("id") ON DELETE CASCADE,
    "sip_domain" text NOT NULL, "sip_username" text NOT NULL, "sip_password" text NOT NULL, "phone_number" text NOT NULL, "outbound_proxy" text,
    "transport" text DEFAULT 'UDP' NOT NULL, "termination_uri" text, "is_enabled" boolean DEFAULT false NOT NULL, "created_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL);
  CREATE TABLE IF NOT EXISTS "external_crm_configs" ("id" serial PRIMARY KEY NOT NULL, "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "name" text NOT NULL, "is_enabled" boolean DEFAULT true NOT NULL, "lookup_url" text NOT NULL, "http_method" text DEFAULT 'GET' NOT NULL,
    "auth_type" text DEFAULT 'bearer' NOT NULL, "auth_value" text, "auth_header_name" text, "phone_param_name" text DEFAULT 'phone' NOT NULL,
    "phone_param_location" text DEFAULT 'query' NOT NULL, "response_mapping" jsonb, "use_raw_response" boolean DEFAULT false NOT NULL,
    "max_context_chars" integer DEFAULT 2000 NOT NULL, "timeout_ms" integer DEFAULT 3000 NOT NULL, "cache_ttl_seconds" integer DEFAULT 300 NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL, UNIQUE("user_id"));
  CREATE TABLE IF NOT EXISTS "widget_chat_sessions" ("id" serial PRIMARY KEY NOT NULL, "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "session_id" text NOT NULL UNIQUE, "phone" text NOT NULL, "order_id" text NOT NULL, "customer_name" text, "transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "last_synced_at" timestamp, "started_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL);
  ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "telephony_type" text DEFAULT 'TWILIO' NOT NULL;
  ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "language_menu_config" jsonb;`;

const uniqueIndexes = (c: any, table: string, column: string) =>
  count(c, `select count(*) n from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = '${table}'::regclass and i.indisunique and i.indnatts = 1 and a.attname = '${column}'`);

test("PostgreSQL: a database built by the former startup DDL is adopted, then reconciled by 0009", { skip }, async (t) => {
  await withDatabase(t, async (connect) => {
    const c = await connect();
    await rawApply(c, throughBaseline);
    await c.query(LEGACY_DB_SYNC);
    await seed(c);
    await c.query(`insert into exotel_configs (tenant_id, account_sid, api_key, api_token, exophone, app_flow_url) values (1, 'enc:a', 'enc:b', 'enc:c', 'enc:d', 'https://flow.test');
      insert into external_crm_configs (user_id, name, lookup_url) values (10, 'CRM', 'https://crm.test/lookup');
      insert into widget_chat_sessions (user_id, session_id, phone, order_id) values (10, 's-1', 'enc:p', 'o-1');`);

    assert.equal((await inspectSchema(c)).status, "not_initialized");
    await assert.rejects(applyMigrations(c, directory), (err: unknown) => err instanceof MigrationError && /adopt/.test(err.message));
    assert.deepEqual(await adoptExistingDatabase(c, directory), throughBaseline);
    await assert.rejects(adoptExistingDatabase(c, directory), /already has migration history/);
    assert.deepEqual(await applyMigrations(c, directory), ["0009_schema_reconciliation", "0010_vobiz_sip_configuration", "0011_livekit_sessions"]);

    const report = await inspectSchema(c);
    assert.deepEqual(report, { status: "ready", pending: [], newerThanCode: 0, missing: [] });
    await assertSeedIntact(c);
    // Existing *_key uniqueness is reused, not duplicated; FKs and data are untouched.
    assert.equal(await uniqueIndexes(c, "widget_chat_sessions", "session_id"), 1);
    assert.equal(await uniqueIndexes(c, "external_crm_configs", "user_id"), 1);
    assert.equal(await count(c, `select count(*) n from external_crm_configs where name = 'CRM' and verify_identity = false and ending_note_lead_seconds = 2`), 1);
    assert.equal(await count(c, `select count(*) n from exotel_configs where api_key = 'enc:b'`), 1);
    assert.equal(await count(c, `select count(*) n from widget_chat_sessions where session_id = 's-1'`), 1);
    assert.equal(await count(c, `select count(*) n from information_schema.columns where table_name = 'tenant_users' and column_name = 'phone'`), 1);
  });
});

// `drizzle-kit push` builds tables and columns from src/schema but never 0008's
// raw CHECK constraints or trigger; simulated by removing exactly those.
async function pushShaped(c: any) {
  await rawApply(c, tags);
  await c.query(`alter table usage_ledger drop constraint usage_ledger_status_check, drop constraint usage_ledger_measurement_check,
      drop constraint usage_ledger_category_check, drop constraint usage_ledger_entry_type_check, drop constraint usage_ledger_currency_check,
      drop constraint usage_ledger_priced_check;
    alter table budget_reservations drop constraint budget_reservations_status_check, drop constraint budget_reservations_amount_check;
    alter table tenant_budget_periods drop constraint tenant_budget_periods_reserved_check;
    drop trigger billing_rate_cards_no_update on billing_rate_cards; drop function billing_rate_cards_immutable();`);
}

test("PostgreSQL: a push-built database is adopted and gains 0008's integrity rules; a failed 0009 rolls back", { skip }, async (t) => {
  await withDatabase(t, async (connect) => {
    const c = await connect();
    await pushShaped(c);
    await seed(c);
    // A row the CHECK would reject makes the whole batch roll back.
    await c.query(`insert into tenant_budget_periods (tenant_id, period, reserved_amount) values (1, '2026-10', -1)`);
    assert.deepEqual(await adoptExistingDatabase(c, directory), throughBaseline);
    await assert.rejects(applyMigrations(c, directory), /tenant_budget_periods_reserved_check/);
    assert.equal(await historyCount(c), throughBaseline.length, "0009 not recorded");
    assert.equal(await count(c, `select count(*) n from pg_constraint where conname = 'usage_ledger_status_check'`), 0, "partial DDL rolled back");
    const blocked = await inspectSchema(c);
    assert.equal(blocked.status, "migrations_pending");
    assert.ok(blocked.missing.includes("trigger billing_rate_cards_no_update"));

    await c.query(`update tenant_budget_periods set reserved_amount = 0 where reserved_amount < 0`);
    assert.deepEqual(await applyMigrations(c, directory), ["0009_schema_reconciliation", "0010_vobiz_sip_configuration", "0011_livekit_sessions"]);
    assert.equal((await inspectSchema(c)).status, "ready");
    await assertSeedIntact(c);
    await assert.rejects(c.query(`insert into usage_ledger (tenant_id, user_id, source, category, provider, model, idempotency_key, measurement, unit, status, event_at)
      values (1, 10, 'test', 'video', 'x', 'm', 'k-2', 'unknown', 'tokens', 'pending', now())`), /usage_ledger_category_check/);
  });
});

test("PostgreSQL: adoption refuses a database missing objects that earlier migrations create", { skip }, async (t) => {
  await withDatabase(t, async (connect) => {
    const c = await connect();
    await rawApply(c, throughBaseline);
    await c.query(`drop table rate_limit_counters; alter table usage_ledger drop column currency cascade`);
    await assert.rejects(adoptExistingDatabase(c, directory), (err: unknown) =>
      err instanceof MigrationError &&
      err.details.includes("table rate_limit_counters") &&
      err.details.includes("column usage_ledger.currency"));
    assert.equal(await count(c, `select count(*) n from information_schema.tables where table_schema = 'drizzle'`), 0, "nothing recorded");
  });
});

test("PostgreSQL: an unreachable database blocks startup with a sanitized error", { skip }, async () => {
  const { Pool } = pgRequire("pg");
  // Loopback port 1 refuses connections; the URL carries a password that must not surface.
  const pool = new Pool({ connectionString: "postgres://dialog_test:not-a-real-secret@127.0.0.1:1/dialog_test_unreachable", connectionTimeoutMillis: 500 }); // secret-scan: allow-fake
  pool.on("error", () => {});
  const retries: string[] = [];
  try {
    const err = await waitForCompatibleSchema(pool, { timeoutMs: 600, retryMs: 200, onRetry: (_n, e) => retries.push(e) }).catch((e) => e);
    assert.ok(err instanceof StartupBlockedError);
    assert.equal(err.reason, "database_unavailable");
    assert.ok(retries.length >= 1);
    for (const text of [err.message, ...retries, ...err.details]) assert.doesNotMatch(text, /not-a-real-secret|postgres:\/\//);
  } finally {
    await pool.end();
  }
});
