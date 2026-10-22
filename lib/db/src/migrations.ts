import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type pg from "pg";
import * as schema from "./schema";

/**
 * The committed migrations, in journal order. Must equal drizzle/meta/_journal.json:
 * the running server compares the database against this list without reading
 * migration files, and the migrate command refuses to run when the two differ.
 */
export const MIGRATION_JOURNAL: readonly { tag: string; when: number }[] = [
  { tag: "0000_gorgeous_chronomancer", when: 1778740098605 },
  { tag: "0001_hot_christian_walker", when: 1781233203139 },
  { tag: "0002_call_media_sessions", when: 1792627200000 },
  { tag: "0003_widget_customer_verification", when: 1792658650391 },
  { tag: "0004_widget_verification_policies", when: 1792660557140 },
  { tag: "0005_twilio_webhook_idempotency", when: 1792661782843 },
  { tag: "0006_api_rate_limits", when: 1792666290120 },
  { tag: "0007_campaign_dispatch_and_suppression", when: 1792678956026 },
  { tag: "0008_usage_ledger_and_budgets", when: 1792681370436 },
  { tag: "0009_schema_reconciliation", when: 1792686113229 },
  { tag: "0010_vobiz_sip_configuration", when: 1792692703968 },
];

// Drizzle's migrator bookkeeping (drizzle-orm defaults).
const HISTORY_SCHEMA = "drizzle";
const HISTORY_TABLE = "__drizzle_migrations";
const HISTORY = `"${HISTORY_SCHEMA}"."${HISTORY_TABLE}"`;
const MIGRATION_LOCK = "dialog.schema_migrations";

/**
 * Databases built with `drizzle-kit push` or the former startup DDL have no
 * migration history. Adoption records migrations up to this one as applied;
 * 0009 and later then run normally and reconcile what those paths left out.
 */
export const ADOPTION_BASELINE = "0008_usage_ledger_and_budgets";
// Columns first guaranteed by migrations after the baseline (table.* = whole table).
const AFTER_BASELINE = [
  "tenants.telephony_type",
  "tenant_users.phone",
  "agent_configs.language_menu_config",
  "agent_configs.widget_external_crm_enabled",
  "exotel_configs.*",
  "sip_trunk_configs.*",
  "external_crm_configs.*",
  "widget_chat_sessions.*",
  "vobiz_sip_configs.*",
];

// Integrity rules that exist only in migration SQL (the TypeScript schema cannot express them).
const REQUIRED_CONSTRAINTS = [
  "usage_ledger_status_check",
  "usage_ledger_measurement_check",
  "usage_ledger_category_check",
  "usage_ledger_entry_type_check",
  "usage_ledger_currency_check",
  "usage_ledger_priced_check",
  "budget_reservations_status_check",
  "budget_reservations_amount_check",
  "tenant_budget_periods_reserved_check",
];
const REQUIRED_TRIGGERS = ["billing_rate_cards_no_update"];

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export type SchemaStatus = "ready" | "not_initialized" | "migrations_pending" | "schema_incomplete";

export interface SchemaReport {
  status: SchemaStatus;
  /** Committed migrations the database has not recorded. */
  pending: string[];
  /** Recorded migrations newer than this build (the database is ahead of the code). */
  newerThanCode: number;
  /** Missing tables, columns, constraints or triggers, by name only. */
  missing: string[];
}

export class MigrationError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(message);
    this.name = "MigrationError";
  }
}

/** Every column the application's Drizzle schema declares, keyed by table. */
export function expectedColumns(): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    tables.set(config.name, config.columns.map((column) => column.name));
  }
  return tables;
}

async function missingObjects(db: Queryable, exclude: string[] = []): Promise<string[]> {
  const { rows } = await db.query(
    `select table_name, column_name from information_schema.columns where table_schema = current_schema()`,
  );
  const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const tablesPresent = new Set(rows.map((r) => r.table_name as string));
  const skipped = (name: string) =>
    exclude.includes(name) || exclude.includes(`${name.split(".")[0]}.*`);
  const missing: string[] = [];
  for (const [table, columns] of [...expectedColumns()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!tablesPresent.has(table)) {
      if (!skipped(`${table}.*`)) missing.push(`table ${table}`);
      continue;
    }
    for (const column of columns)
      if (!present.has(`${table}.${column}`) && !skipped(`${table}.${column}`))
        missing.push(`column ${table}.${column}`);
  }
  return missing;
}

async function missingMigrationOnlyObjects(db: Queryable): Promise<string[]> {
  const constraints = await db.query(
    `select c.conname from pg_constraint c join pg_namespace n on n.oid = c.connamespace
     where n.nspname = current_schema() and c.conname = any($1)`,
    [REQUIRED_CONSTRAINTS],
  );
  const triggers = await db.query(
    `select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = current_schema() and t.tgname = any($1)`,
    [REQUIRED_TRIGGERS],
  );
  const found = new Set([...constraints.rows.map((r) => r.conname), ...triggers.rows.map((r) => r.tgname)]);
  return [
    ...REQUIRED_CONSTRAINTS.filter((name) => !found.has(name)).map((name) => `constraint ${name}`),
    ...REQUIRED_TRIGGERS.filter((name) => !found.has(name)).map((name) => `trigger ${name}`),
  ];
}

/** Recorded migrations, or null when the database has no migration history. */
export async function readMigrationHistory(db: Queryable): Promise<{ hash: string; createdAt: number }[] | null> {
  const { rows } = await db.query(`select to_regclass($1) is not null as present`, [HISTORY]);
  if (!rows[0]?.present) return null;
  const history = await db.query(`select hash, created_at from ${HISTORY} order by created_at`);
  return history.rows.map((r) => ({ hash: r.hash, createdAt: Number(r.created_at) }));
}

/** Read-only comparison of the database against this build's migrations and schema. */
export async function inspectSchema(db: Queryable): Promise<SchemaReport> {
  const history = await readMigrationHistory(db);
  const recorded = new Set((history ?? []).map((row) => row.createdAt));
  const pending = MIGRATION_JOURNAL.filter((m) => !recorded.has(m.when)).map((m) => m.tag);
  const latest = MIGRATION_JOURNAL[MIGRATION_JOURNAL.length - 1].when;
  const newerThanCode = (history ?? []).filter((row) => row.createdAt > latest).length;
  const missing = [...(await missingObjects(db)), ...(await missingMigrationOnlyObjects(db))];
  const status: SchemaStatus =
    history === null || history.length === 0
      ? "not_initialized"
      : pending.length > 0
        ? "migrations_pending"
        : missing.length > 0
          ? "schema_incomplete"
          : "ready";
  return { status, pending, newerThanCode, missing };
}

/**
 * Locates committed migration files: DB_MIGRATIONS_DIR, the repository layout
 * relative to the working directory, or relative to the running script.
 */
export function resolveMigrationsFolder(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.DB_MIGRATIONS_DIR,
    path.resolve(process.cwd(), "lib/db/drizzle"),
    process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "../../../lib/db/drizzle") : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => existsSync(path.join(candidate, "meta/_journal.json")));
  if (!found) throw new MigrationError("Migration files not found; set DB_MIGRATIONS_DIR to lib/db/drizzle");
  return found;
}

/** Reads migration files, refusing when they disagree with MIGRATION_JOURNAL. */
export function loadMigrationFiles(folder: string) {
  const journal = JSON.parse(readFileSync(path.join(folder, "meta/_journal.json"), "utf8"));
  const files = journal.entries.map((e: { tag: string; when: number }) => `${e.tag}@${e.when}`);
  const built = MIGRATION_JOURNAL.map((m) => `${m.tag}@${m.when}`);
  if (files.join("\n") !== built.join("\n"))
    throw new MigrationError("Migration files do not match this build's migration list", [
      ...files.filter((f: string) => !built.includes(f)).map((f: string) => `only in files: ${f}`),
      ...built.filter((b) => !files.includes(b)).map((b) => `only in build: ${b}`),
    ]);
  return readMigrationFiles({ migrationsFolder: folder }).map((m, i) => ({
    tag: MIGRATION_JOURNAL[i].tag,
    when: m.folderMillis,
    hash: m.hash,
  }));
}

/** Applied migrations whose file content changed since they were recorded. */
export async function modifiedMigrations(db: Queryable, folder: string): Promise<string[]> {
  const history = (await readMigrationHistory(db)) ?? [];
  const byWhen = new Map(history.map((row) => [row.createdAt, row.hash]));
  return loadMigrationFiles(folder)
    .filter((m) => byWhen.has(m.when) && byWhen.get(m.when) !== m.hash)
    .map((m) => m.tag);
}

async function withMigrationLock<T>(client: Queryable, run: () => Promise<T>): Promise<T> {
  // Concurrent deploys queue here; the second sees nothing pending.
  await client.query(`select pg_advisory_lock(hashtext($1))`, [MIGRATION_LOCK]);
  try {
    return await run();
  } finally {
    await client.query(`select pg_advisory_unlock(hashtext($1))`, [MIGRATION_LOCK]);
  }
}

async function hasApplicationTables(db: Queryable): Promise<boolean> {
  const { rows } = await db.query(
    `select count(*)::int as n from information_schema.tables where table_schema = current_schema() and table_name = any($1)`,
    [["users", "tenants"]],
  );
  return rows[0].n > 0;
}

export interface ApplyOptions {
  /** Upper bound on waiting for table locks held by running traffic. */
  lockTimeout?: string;
}

/**
 * Applies pending migrations with drizzle-orm's migrator (one transaction for
 * the whole batch) under an advisory lock. `client` must be a dedicated
 * connection, not a pool.
 */
export async function applyMigrations(
  client: pg.PoolClient | pg.Client,
  folder: string,
  options: ApplyOptions = {},
): Promise<string[]> {
  const files = loadMigrationFiles(folder);
  return withMigrationLock(client, async () => {
    const history = await readMigrationHistory(client);
    if ((history === null || history.length === 0) && (await hasApplicationTables(client)))
      throw new MigrationError(
        "Database has application tables but no migration history; run `adopt` first (see database-migrations-and-startup.md)",
      );
    const recorded = new Set((history ?? []).map((row) => row.createdAt));
    const last = Math.max(0, ...recorded);
    // Drizzle applies only migrations newer than the latest record; an older
    // unrecorded one would be skipped silently.
    const skipped = files.filter((m) => !recorded.has(m.when) && m.when <= last).map((m) => m.tag);
    if (skipped.length > 0)
      throw new MigrationError("Unrecorded migrations precede the latest recorded one", skipped);
    const pending = files.filter((m) => !recorded.has(m.when)).map((m) => m.tag);
    if (pending.length === 0) return [];
    await client.query(`select set_config('lock_timeout', $1, false)`, [options.lockTimeout ?? "15s"]);
    try {
      await migrate(drizzle(client), { migrationsFolder: folder });
    } finally {
      await client.query(`select set_config('lock_timeout', '0', false)`);
    }
    return pending;
  });
}

/**
 * Records migrations through ADOPTION_BASELINE as applied on a database that was
 * built without migration history. Refuses unless every table and column those
 * migrations create is already present; never changes application tables.
 */
export async function adoptExistingDatabase(client: Queryable, folder: string): Promise<string[]> {
  const files = loadMigrationFiles(folder);
  const baselineIndex = files.findIndex((m) => m.tag === ADOPTION_BASELINE);
  return withMigrationLock(client, async () => {
    const history = await readMigrationHistory(client);
    if (history && history.length > 0)
      throw new MigrationError("Database already has migration history; adoption is only for databases without it");
    if (!(await hasApplicationTables(client)))
      throw new MigrationError("Database has no application tables; run `apply` to install from migrations");
    const missing = await missingObjects(client, AFTER_BASELINE);
    if (missing.length > 0)
      throw new MigrationError(`Database is missing objects that migrations through ${ADOPTION_BASELINE} create`, missing);
    const baseline = files.slice(0, baselineIndex + 1);
    await client.query("begin");
    try {
      await client.query(`create schema if not exists "${HISTORY_SCHEMA}"`);
      await client.query(
        `create table if not exists ${HISTORY} (id serial primary key, hash text not null, created_at bigint)`,
      );
      for (const m of baseline)
        await client.query(`insert into ${HISTORY} (hash, created_at) values ($1, $2)`, [m.hash, m.when]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
    return baseline.map((m) => m.tag);
  });
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);

/** True when the database could not be reached, as opposed to rejecting a query. */
export function isDatabaseUnavailable(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code && NETWORK_CODES.has(e.code)) return true;
  // 57P03 cannot_connect_now (starting up / shutting down); 08xxx connection exceptions.
  if (e.code === "57P03" || (typeof e.code === "string" && e.code.startsWith("08"))) return true;
  return /timeout|terminated unexpectedly|Connection terminated/i.test(e.message ?? "");
}

/**
 * One-line description safe for logs: SQLSTATE or network code plus a message
 * with connection URLs and quoted identifiers of credentials removed. Never
 * includes query parameters or `detail` (which can carry row values).
 */
export function describeDatabaseError(err: unknown): string {
  if (err instanceof MigrationError)
    return err.details.length ? `${err.message}: ${err.details.join(", ")}` : err.message;
  const e = err as { code?: string; message?: string } | null;
  const code = typeof e?.code === "string" ? e.code : "unknown";
  if (code === "28P01" || code === "28000") return `database authentication failed (${code})`;
  if (NETWORK_CODES.has(code)) return `database unreachable (${code})`;
  const message = String(e?.message ?? "")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/password[^,;]*/gi, "<redacted>")
    .slice(0, 300);
  return `${code}: ${message}`;
}
