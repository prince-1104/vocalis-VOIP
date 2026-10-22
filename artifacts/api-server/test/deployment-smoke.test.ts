import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { applyMigrations } from "@workspace/db/migrations";
import { configuredEntrypoints } from "../deploy-entrypoints.mjs";
import { configured, directory, migrateThrough, withDatabase } from "./pg-databases";

// Runs the real build output (dist/) the way deployments do: the Replit run
// command, the db:migrate package script, and the package-config schema push.
const repoRoot = path.resolve("../..");
const built = existsSync(path.join(repoRoot, "artifacts/api-server/dist"));
const drizzleKit = path.join(repoRoot, "lib/db/node_modules/drizzle-kit/bin.cjs");
const dbDir = path.join(repoRoot, "lib/db");
const skip = !configured && "TEST_DATABASE_URL not supplied; isolated PostgreSQL unavailable";

test("PostgreSQL: push is permitted against a confirmed throwaway loopback database", { skip }, async (t) => {
  await withDatabase(t, async (connect, url) => {
    const name = new URL(url).pathname.slice(1);
    const result = await run(process.execPath, [drizzleKit, "push", "--force", "--config", "./drizzle.config.ts"], {
      cwd: dbDir,
      env: { ...process.env, NODE_ENV: "development", DATABASE_URL: url, DIALOG_SCHEMA_PUSH_DATABASE: name },
    });
    assert.equal(result.code, 0, result.output.replace(url, "<url>"));
    const c = await connect();
    assert.equal((await c.query(`select to_regclass('public.usage_ledger') is not null as ok`)).rows[0].ok, true);
  });
});

// ── Built server through the configured Replit command ───────────────────────

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise((r) => server.close(r));
  return port;
}

// The artifact.toml production command and environment, plus the settings
// production startup requires; the rate-limit store is the migrated database.
function startConfigured(url: string, port: number) {
  const manifestArgs = ["--enable-source-maps", configuredEntrypoints(repoRoot)[0].file];
  return spawnCollect(process.execPath, manifestArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      TRUST_PROXY: "none",
      RATE_LIMIT_STORE: "postgres",
      DATABASE_URL: url,
      PORT: String(port),
      LOG_LEVEL: "info",
      DB_STARTUP_TIMEOUT_MS: "3000",
    },
  });
}

/** Starts the built server and expects it to refuse: exit 1, `reason`, never listening. */
async function expectStartupRefusal(url: string, reason: RegExp, secret?: string) {
  const blocked = startConfigured(url, await freePort());
  const code = await Promise.race([blocked.exit, delay(20_000, true).then(() => "timeout")]);
  if (code === "timeout") blocked.child.kill();
  assert.equal(code, 1, blocked.output());
  assert.match(blocked.output(), /startup_blocked/);
  assert.match(blocked.output(), reason);
  assert.doesNotMatch(blocked.output(), /Server listening/);
  if (secret) assert.ok(!blocked.output().includes(secret), "startup output never contains the database password");
}

const needsBuild = !built && "artifacts/api-server/dist not built; run the API build first";

test("Built entrypoint: an unreachable database makes startup exit nonzero after retrying", { skip: needsBuild }, async () => {
  await expectStartupRefusal("postgres://ci@127.0.0.1:1/dialog_test_unreachable", /database_unavailable/);
});

test(
  "PostgreSQL: the configured build entrypoint serves only after the schema check; empty and pending databases block it",
  { skip: skip || needsBuild },
  async (t) => {
    const password = new URL(configured!).password;
    await withDatabase(t, async (connect, url) => {
      const c = await connect();
      await expectStartupRefusal(url, /not_initialized/, password);
      await migrateThrough(c, "0008_usage_ledger_and_budgets");
      await expectStartupRefusal(url, /migrations_pending[\s\S]*0009_schema_reconciliation|0009_schema_reconciliation[\s\S]*migrations_pending/, password);

      await applyMigrations(c, directory);
      const port = await freePort();
      const server = startConfigured(url, port);
      try {
        let ready: Response | undefined;
        for (let i = 0; i < 80 && ready?.status !== 200; i++) {
          await delay(250);
          ready = await fetch(`http://127.0.0.1:${port}/api/readyz`).catch(() => undefined);
        }
        assert.equal(ready?.status, 200, server.output());
        assert.deepEqual(await ready.json(), { status: "ready" });
        const live = await fetch(`http://127.0.0.1:${port}/api/healthz`);
        assert.deepEqual([live.status, await live.json()], [200, { status: "ok" }]);
        assert.match(server.output(), /schema_ready/);
        if (password) assert.ok(!server.output().includes(password));
      } finally {
        server.child.kill();
        await server.exit;
      }
    });
  },
);

// ── Built migration CLI (`db:migrate`) ───────────────────────────────────────

const REQUIRED_CHECKS = [
  "budget_reservations_amount_check",
  "budget_reservations_status_check",
  "tenant_budget_periods_reserved_check",
  "usage_ledger_category_check",
  "usage_ledger_currency_check",
  "usage_ledger_entry_type_check",
  "usage_ledger_measurement_check",
  "usage_ledger_priced_check",
  "usage_ledger_status_check",
];

async function validatedChecks(c: any): Promise<string[]> {
  return (await c.query(`select conname from pg_constraint
    where contype = 'c' and convalidated and conname = any($1) order by conname`, [REQUIRED_CHECKS])).rows.map((r: any) => r.conname);
}

test(
  "PostgreSQL: the built db:migrate CLI installs a fresh database and upgrades an existing one to a ready schema",
  { skip: skip || needsBuild },
  async (t) => {
    const apiDir = path.join(repoRoot, "artifacts/api-server");
    const pkg = JSON.parse(await readFile(path.join(apiDir, "package.json"), "utf8"));
    assert.equal(pkg.scripts["db:migrate"], "node --enable-source-maps ./dist/db-migrate.cjs");
    const password = new URL(configured!).password;
    const cli = async (url: string, command: string) => {
      const result = await run(process.execPath, ["--enable-source-maps", "./dist/db-migrate.cjs", command], {
        cwd: apiDir,
        env: { ...process.env, NODE_ENV: "production", DATABASE_URL: url },
      });
      if (password) assert.ok(!result.output.includes(password), "CLI output never contains the database password");
      // `status` prints one report; `apply` prints what it applied, then the report.
      const docs = () => result.stdout.trim().split(/\r?\n(?=\{)/).map((doc) => JSON.parse(doc));
      return { ...result, json: () => docs()[0], report: () => docs().at(-1) };
    };
    const tags = (await readdir(directory)).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")).sort();

    // Fresh install.
    await withDatabase(t, async (connect, url) => {
      const empty = await cli(url, "status");
      assert.equal(empty.code, 3, empty.output);
      assert.equal(empty.json().status, "not_initialized");
      const apply = await cli(url, "apply");
      assert.equal(apply.code, 0, apply.output);
      assert.deepEqual(apply.json().applied, tags);
      const ready = await cli(url, "status");
      assert.equal(ready.code, 0, ready.output);
      assert.deepEqual(ready.json(), { status: "ready", pending: [], newerThanCode: 0, missing: [], modifiedAfterApply: [] });
      assert.deepEqual((await cli(url, "apply")).json().applied, [], "re-running apply is a no-op");
      const c = await connect();
      assert.deepEqual(await validatedChecks(c), REQUIRED_CHECKS);
    });

    // Existing database from the previous release (through 0008) with data.
    await withDatabase(t, async (connect, url) => {
      const c = await connect();
      await migrateThrough(c, "0008_usage_ledger_and_budgets");
      await c.query(`insert into users (id, email) values (10, 'owner@example.test');
        insert into tenants (id, name, slug, owner_id, commission_pct) values (1, 'Tenant A', 'a', 10, 20);`);
      const pending = await cli(url, "status");
      assert.equal(pending.code, 3);
      assert.deepEqual(pending.json().pending, ["0009_schema_reconciliation"]);
      const apply = await cli(url, "apply");
      assert.equal(apply.code, 0, apply.output);
      assert.deepEqual(apply.json().applied, ["0009_schema_reconciliation"]);
      assert.equal(apply.report().status, "ready");
      assert.equal((await cli(url, "status")).code, 0);
      assert.deepEqual(await validatedChecks(c), REQUIRED_CHECKS);
      assert.deepEqual((await c.query(`select telephony_type from tenants where id = 1`)).rows, [{ telephony_type: "TWILIO" }]);
    });
  },
);

// ── helpers ──────────────────────────────────────────────────────────────────

const delay = (ms: number, unref = false) =>
  new Promise((r) => {
    const timer = setTimeout(r, ms);
    if (unref) timer.unref();
  });

function spawnCollect(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let stdout = "";
  child.stdout.on("data", (d) => ((output += d), (stdout += d)));
  child.stderr.on("data", (d) => (output += d));
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, exit, output: () => output, stdout: () => stdout };
}

async function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const p = spawnCollect(command, args, options);
  const code = await p.exit;
  return { code, output: p.output(), stdout: p.stdout() };
}
