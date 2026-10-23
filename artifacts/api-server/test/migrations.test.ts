import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  describeDatabaseError,
  expectedColumns,
  inspectSchema,
  loadMigrationFiles,
  MIGRATION_JOURNAL,
  MigrationError,
  type Queryable,
} from "@workspace/db/migrations";
import {
  createReadiness,
  runStartup,
  StartupBlockedError,
  waitForCompatibleSchema,
} from "../src/lib/schema-readiness";
import healthRouter, { setReadinessCheck } from "../src/routes/health";

const directory = path.resolve("../../lib/db/drizzle");

test("Migration journal: build list, journal file, SQL files and snapshot chain agree", async () => {
  const journal = JSON.parse(await readFile(path.join(directory, "meta/_journal.json"), "utf8"));
  assert.deepEqual(
    journal.entries.map((e: any) => ({ tag: e.tag, when: e.when })),
    MIGRATION_JOURNAL,
  );
  const whens = journal.entries.map((e: any) => e.when);
  assert.deepEqual(whens, [...whens].sort((a, b) => a - b), "journal timestamps must increase");
  let previousId: string | undefined;
  for (const [index, entry] of journal.entries.entries()) {
    assert.equal(entry.idx, index);
    assert.ok(existsSync(path.join(directory, `${entry.tag}.sql`)), entry.tag);
    const snapshot = JSON.parse(
      await readFile(path.join(directory, `meta/${entry.tag.slice(0, 4)}_snapshot.json`), "utf8"),
    );
    if (previousId) assert.equal(snapshot.prevId, previousId, `${entry.tag} snapshot chain`);
    previousId = snapshot.id;
  }
  assert.deepEqual(loadMigrationFiles(directory).map((m) => m.tag), MIGRATION_JOURNAL.map((m) => m.tag));
});

test("0009 is additive and idempotent: every statement is guarded, nothing is dropped or rewritten", async () => {
  const sql = await readFile(path.join(directory, "0009_schema_reconciliation.sql"), "utf8");
  const body = sql.replace(/^--.*$/gm, "");
  assert.ok(!/\b(DROP|RENAME|TRUNCATE|DELETE\s+FROM|UPDATE\s+"|INSERT\s+INTO)\b/i.test(body.replace(/ON DELETE cascade/gi, "").replace(/BEFORE UPDATE OR DELETE/g, "")));
  for (const statement of body.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean))
    assert.match(
      statement,
      /^(ALTER TABLE "public"\."\w+" ADD COLUMN IF NOT EXISTS |CREATE TABLE IF NOT EXISTS |CREATE INDEX IF NOT EXISTS |DO \$\$)/,
      statement.slice(0, 80),
    );
  // No unguarded DDL hides inside the DO blocks.
  for (const ddl of body.matchAll(/^\s*(ALTER TABLE|CREATE (UNIQUE INDEX|TRIGGER)|EXECUTE)\b.*$/gm))
    if (!/IF NOT EXISTS/.test(ddl[0]))
      assert.ok(/^\s*(ALTER TABLE "\w+" ADD CONSTRAINT|CREATE UNIQUE INDEX|CREATE TRIGGER|EXECUTE \$fn\$)/.test(ddl[0]), ddl[0]);
  assert.equal((body.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g) ?? []).length, 9);
  assert.match(body, /ADD COLUMN IF NOT EXISTS "telephony_type" text DEFAULT 'TWILIO' NOT NULL/);
});

test("Migration files that disagree with the build's list are refused", async () => {
  const copy = await mkdtemp(path.join(tmpdir(), "dialog-migrations-"));
  try {
    await cp(directory, copy, { recursive: true });
    const journalPath = path.join(copy, "meta/_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.entries.pop();
    await writeFile(journalPath, JSON.stringify(journal));
    assert.throws(() => loadMigrationFiles(copy), (err: unknown) =>
      err instanceof MigrationError && err.details.includes(`only in build: ${MIGRATION_JOURNAL.at(-1)!.tag}@${MIGRATION_JOURNAL.at(-1)!.when}`));
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
});

// A scripted catalog standing in for PostgreSQL's answers to inspectSchema.
function fakeCatalog(options: { history: number[] | null; dropColumn?: string; failWith?: Error }): Queryable & { calls: number } {
  const fake = {
    calls: 0,
    async query(text: string) {
      fake.calls++;
      if (options.failWith) throw options.failWith;
      if (text.includes("to_regclass")) return { rows: [{ present: options.history !== null }] };
      if (text.includes("__drizzle_migrations")) return { rows: (options.history ?? []).map((w) => ({ hash: "h", created_at: String(w) })) };
      if (text.includes("information_schema.columns")) {
        const rows = [];
        for (const [table, columns] of expectedColumns())
          for (const column of columns)
            if (`${table}.${column}` !== options.dropColumn) rows.push({ table_name: table, column_name: column });
        return { rows };
      }
      if (text.includes("pg_constraint")) return { rows: Array.from({ length: 9 }, (_, i) => ({ conname: ["usage_ledger_status_check", "usage_ledger_measurement_check", "usage_ledger_category_check", "usage_ledger_entry_type_check", "usage_ledger_currency_check", "usage_ledger_priced_check", "budget_reservations_status_check", "budget_reservations_amount_check", "tenant_budget_periods_reserved_check"][i] })) };
      if (text.includes("pg_trigger")) return { rows: [{ tgname: "billing_rate_cards_no_update" }] };
      return { rows: [{ "?column?": 1 }] };
    },
  };
  return fake;
}

const all = MIGRATION_JOURNAL.map((m) => m.when);

test("Schema inspection classifies history and objects without reading migration files", async () => {
  assert.equal((await inspectSchema(fakeCatalog({ history: all }))).status, "ready");
  assert.equal((await inspectSchema(fakeCatalog({ history: null }))).status, "not_initialized");
  const pending = await inspectSchema(fakeCatalog({ history: all.slice(0, 9), dropColumn: "tenants.telephony_type" }));
  assert.equal(pending.status, "migrations_pending");
  assert.deepEqual(pending.pending, ["0009_schema_reconciliation", "0010_vobiz_sip_configuration", "0011_livekit_sessions"]);
  assert.ok(pending.missing.includes("column tenants.telephony_type"));
  const incomplete = await inspectSchema(fakeCatalog({ history: all, dropColumn: "usage_ledger.currency" }));
  assert.equal(incomplete.status, "schema_incomplete");
  assert.deepEqual(incomplete.missing, ["column usage_ledger.currency"]);
  // A newer database (rolled-back code) is reported, not refused.
  const ahead = await inspectSchema(fakeCatalog({ history: [...all, all[all.length - 1] + 1] }));
  assert.equal(ahead.status, "ready");
  assert.equal(ahead.newerThanCode, 1);
});

test("Startup: an incompatible schema fails at once; nothing listens and no worker starts", async () => {
  for (const [history, reason] of [[null, "not_initialized"], [all.slice(0, 9), "migrations_pending"]] as const) {
    const db = fakeCatalog({ history: history as number[] | null });
    const events: string[] = [];
    await assert.rejects(
      runStartup({
        checkSchema: () => waitForCompatibleSchema(db, { sleep: async () => { events.push("sleep"); } }),
        prepare: async () => { events.push("prepare"); },
        listen: async () => { events.push("listen"); },
        startWorkers: () => { events.push("workers"); },
        markReady: () => { events.push("ready"); },
      }),
      (err: unknown) => err instanceof StartupBlockedError && err.reason === reason,
    );
    assert.deepEqual(events, [], "no retry, listen or worker start");
  }
  const events: string[] = [];
  await runStartup({
    checkSchema: () => waitForCompatibleSchema(fakeCatalog({ history: all })),
    prepare: async () => { events.push("prepare"); },
    listen: async () => { events.push("listen"); },
    startWorkers: () => { events.push("workers"); },
    markReady: () => { events.push("ready"); },
  });
  assert.deepEqual(events, ["prepare", "listen", "workers", "ready"]);
});

test("Startup: an unreachable database is retried until the deadline, then refused with a sanitized error", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432 postgres://admin:hunter2@db.prod.test/prod"), { code: "ECONNREFUSED" });
  const db = fakeCatalog({ history: all, failWith: refused });
  let clock = 0;
  const retries: string[] = [];
  const err = await waitForCompatibleSchema(db, {
    timeoutMs: 5_000,
    retryMs: 1_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    onRetry: (_attempt, error) => retries.push(error),
  }).catch((e) => e);
  assert.ok(err instanceof StartupBlockedError);
  assert.equal(err.reason, "database_unavailable");
  assert.equal(db.calls, 6);
  for (const text of [err.message, ...retries]) {
    assert.doesNotMatch(text, /hunter2|admin|postgres:\/\//);
    assert.match(text, /database unreachable \(ECONNREFUSED\)/);
  }
  // A query error that is not a connectivity problem is not retried.
  const denied = Object.assign(new Error("permission denied for table users"), { code: "42501" });
  const once_ = fakeCatalog({ history: all, failWith: denied });
  await assert.rejects(waitForCompatibleSchema(once_, { sleep: async () => assert.fail("retried") }),
    (e: unknown) => e instanceof StartupBlockedError && e.reason === "schema_check_failed");
  assert.equal(once_.calls, 1);
});

test("Database error descriptions never carry credentials, URLs or row details", () => {
  const auth = Object.assign(new Error('password authentication failed for user "dialog"'), { code: "28P01" });
  assert.equal(describeDatabaseError(auth), "database authentication failed (28P01)");
  const unique = Object.assign(new Error('duplicate key value violates unique constraint "x"'), {
    code: "23505",
    detail: "Key (phone)=(+15550001111) already exists.",
  });
  assert.doesNotMatch(describeDatabaseError(unique), /15550001111/);
  const url = Object.assign(new Error("bad config postgresql://u:secretpw@host.test:5432/db?sslmode=require"), { code: "XX000" });
  assert.doesNotMatch(describeDatabaseError(url), /secretpw|postgresql:\/\//);
  assert.match(describeDatabaseError(new MigrationError("refused", ["table users"])), /refused: table users/);
});

test("Liveness stays up while readiness reflects startup state and current database reachability", async () => {
  let dbUp = true;
  const db: Queryable = { query: async () => { if (!dbUp) throw new Error("down"); return { rows: [{ ready: 1 }] }; } };
  let clock = 0;
  const readiness = createReadiness(db, { cacheMs: 1_000, now: () => clock });
  setReadinessCheck(() => readiness.check());
  const app = express();
  app.use("/api", healthRouter);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const get = async (p: string) => {
    const res = await fetch(base + p);
    return [res.status, await res.json()] as const;
  };
  try {
    assert.deepEqual(await get("/healthz"), [200, { status: "ok" }]);
    assert.deepEqual(await get("/readyz"), [503, { status: "starting" }]);
    readiness.markReady();
    assert.deepEqual(await get("/readyz"), [200, { status: "ready" }]);
    dbUp = false;
    clock += 1_000;
    assert.deepEqual(await get("/readyz"), [503, { status: "database_unavailable" }]);
    assert.deepEqual(await get("/healthz"), [200, { status: "ok" }], "liveness ignores the database");
    readiness.markBlocked();
    assert.deepEqual(await get("/readyz"), [503, { status: "blocked" }]);
  } finally {
    server.close();
  }
});

import "./postgres-migrations.test";
