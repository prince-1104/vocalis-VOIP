import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresRateLimitStore } from "../src/lib/rate-limit";

const configured = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL: rate-limit counters are atomic across independent connections",
  {
    skip:
      !configured &&
      "TEST_DATABASE_URL not supplied; isolated PostgreSQL unavailable",
  },
  async () => {
    const url = new URL(configured!);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
      "Test database must be loopback",
    );
    assert.match(url.pathname, /^\/dialog_test_[a-zA-Z0-9_]+$/);
    assert.equal(url.search, "", "No connection option overrides allowed");
    const require = createRequire(path.resolve("../../lib/db/package.json"));
    const { Client } = require("pg");
    const clients = Array.from({ length: 4 }, () => new Client({ connectionString: configured }));
    const namespace = "dialog_rate_limit_" + randomUUID().replaceAll("-", "");
    let created = false;
    try {
      await Promise.all(clients.map((client) => client.connect()));
      await clients[0].query(`create schema "${namespace}"`);
      created = true;
      await Promise.all(clients.map((client) => client.query(`set search_path to "${namespace}"`)));
      const ddl = await readFile(path.resolve("../../lib/db/drizzle/0006_api_rate_limits.sql"), "utf8");
      for (const statement of ddl.replaceAll('"public".', "").split("--> statement-breakpoint"))
        if (statement.trim()) await clients[0].query(statement);

      // One store per connection stands in for one store per app instance. Each
      // client queues 50 of the 200 contended statements, so the production
      // per-call timeout would measure queueing, not atomicity.
      const stores = clients.map((client) => createPostgresRateLimitStore(drizzle(client) as any, { timeoutMs: 30_000 }));
      const windowMs = 60_000;
      const windowStart = 1_800_000_000_000 - (1_800_000_000_000 % windowMs);

      // 200 concurrent increments: every count from 1..200 is observed exactly once.
      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) => stores[i % stores.length].add("test.policy:k", windowStart, windowMs, 1)),
      );
      assert.deepEqual(results.map((r) => r.current).sort((a, b) => a - b), Array.from({ length: 200 }, (_, i) => i + 1));

      // Refunds from several instances never drive the counter below zero.
      await Promise.all(Array.from({ length: 250 }, (_, i) => stores[i % stores.length].add("test.policy:k", windowStart, windowMs, -1)));
      assert.equal((await stores[0].add("test.policy:k", windowStart, windowMs, 0)).current, 0);

      // The next window sees this window as "previous".
      await stores[1].add("test.policy:k", windowStart, windowMs, 3);
      assert.deepEqual(await stores[2].add("test.policy:k", windowStart + windowMs, windowMs, 1), { current: 1, previous: 3 });

      const stored = (await clients[0].query(`select bucket_key from rate_limit_counters`)).rows.map((r: any) => r.bucket_key);
      assert.ok(stored.every((key: string) => key === "test.policy:k"));
    } finally {
      if (created) await clients[0].query(`drop schema "${namespace}" cascade`);
      await Promise.allSettled(clients.map((client) => client.end()));
    }
  },
);
