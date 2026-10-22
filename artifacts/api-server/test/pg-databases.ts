import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Each scenario gets its own database (the migrator writes the `drizzle` schema
// and migrations name "public"), created next to TEST_DATABASE_URL's database
// with the same dialog_test_ prefix and dropped afterwards.
export const configured = process.env.TEST_DATABASE_URL;
export const directory = path.resolve("../../lib/db/drizzle");
export const pgRequire = createRequire(path.resolve("../../lib/db/package.json"));

function guardedUrl(): URL {
  const url = new URL(configured!);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Test database must be loopback");
  assert.match(url.pathname, /^\/dialog_test_[a-zA-Z0-9_]+$/);
  assert.equal(url.search, "", "No connection option overrides allowed");
  return url;
}

/** `run` receives a connection factory and the database URL (for child processes). */
export async function withDatabase(t: any, run: (connect: () => Promise<any>, url: string) => Promise<void>) {
  const { Client } = pgRequire("pg");
  const base = guardedUrl();
  const name = `${base.pathname.slice(1, 40)}_m${randomBytes(4).toString("hex")}`;
  assert.match(name, /^dialog_test_[a-z0-9_]+$/);
  const admin = new Client({ connectionString: configured });
  await admin.connect();
  const opened: any[] = [];
  try {
    try {
      await admin.query(`create database "${name}"`);
    } catch (err: any) {
      if (err.code === "42501") return t.skip("TEST_DATABASE_URL role lacks CREATEDB; migration lifecycle not exercised");
      throw err;
    }
    const url = new URL(base);
    url.pathname = `/${name}`;
    await run(async () => {
      const client = new Client({ connectionString: url.toString() });
      await client.connect();
      opened.push(client);
      return client;
    }, url.toString());
  } finally {
    await Promise.all(opened.map((c) => c.end().catch(() => {})));
    await admin.query(`drop database if exists "${name}" with (force)`).catch(() => {});
    await admin.end();
  }
}

export async function rawApply(client: any, tags: string[]) {
  for (const tag of tags) {
    const sql = await readFile(path.join(directory, `${tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) if (statement.trim()) await client.query(statement);
  }
}

// What a previous release's migrator would have applied: the journal through `last`.
export async function migrateThrough(client: any, last: string) {
  const copy = await mkdtemp(path.join(tmpdir(), "dialog-migrations-"));
  try {
    await cp(directory, copy, { recursive: true });
    const journalPath = path.join(copy, "meta/_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e: any) => e.tag === last) + 1);
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(drizzle(client), { migrationsFolder: copy });
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}
