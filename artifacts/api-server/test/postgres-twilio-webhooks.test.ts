import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  claimCallFinalization,
  releaseTransferSlot,
  reserveTransferSlot,
} from "../src/lib/transfer-slots";
import * as schema from "./fake-db";

const configured = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL: finalization and transfer-slot claims are single-winner across independent connections",
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
    const clients = [
      new Client({ connectionString: configured }),
      new Client({ connectionString: configured }),
    ];
    const namespace = "dialog_twilio_" + randomUUID().replaceAll("-", "");
    let created = false;
    try {
      await Promise.all(clients.map((client) => client.connect()));
      await clients[0].query(`create schema "${namespace}"`);
      created = true;
      await Promise.all(
        clients.map((client) => client.query(`set search_path to "${namespace}"`)),
      );
      // The real call_logs / crm_agents DDL, confined to the throwaway schema.
      for (const file of [
        "0000_gorgeous_chronomancer.sql",
        "0001_hot_christian_walker.sql",
        "0005_twilio_webhook_idempotency.sql",
      ]) {
        const sql = await readFile(path.resolve("../../lib/db/drizzle", file), "utf8");
        for (const statement of sql.replaceAll('"public".', "").split("--> statement-breakpoint"))
          if (statement.trim()) await clients[0].query(statement);
      }
      await clients[0].query(`insert into users (id) values (10);
        insert into crm_agents (id, user_id, crm_agent_id, name, current_calls) values (1, 10, 'agent-a', 'Fake agent', 1);
        insert into call_logs (id, user_id, phone) values (1, 10, '+15550000009'), (2, 10, '+15550000009');`);
      const [first, second] = clients.map((client) => drizzle(client, { schema }) as any);
      const agentCalls = async () =>
        (await clients[0].query(`select current_calls from crm_agents where id = 1`)).rows[0].current_calls;

      // Two connections reserve slots for different calls concurrently: no lost update.
      await Promise.all([
        reserveTransferSlot(1, 10, "crm-transfer-1-1", "agent-a", first),
        reserveTransferSlot(2, 10, "crm-transfer-2-1", "agent-a", second),
      ]);
      assert.equal(await agentCalls(), 3);

      // Duplicate releases of the same transfer race across connections: one decrement.
      const released = await Promise.all([
        releaseTransferSlot(1, "crm-transfer-1-1", first),
        releaseTransferSlot(1, "crm-transfer-1-1", second),
      ]);
      assert.equal(released.filter(Boolean).length, 1);
      assert.equal(await agentCalls(), 2);
      assert.equal(await releaseTransferSlot(2, "crm-transfer-2-stale", first), false);
      assert.equal(await agentCalls(), 2);

      // Concurrent terminal finalizations: exactly one winner, terminal values kept.
      const finalized = await Promise.all([
        claimCallFinalization(1, { outcome: "no_answer", duration: 0 }, first),
        claimCallFinalization(1, { outcome: "answered", duration: 30 }, second),
      ]);
      assert.equal(finalized.filter(Boolean).length, 1);
      const winner = finalized[0] ? "no_answer" : "answered";
      assert.equal(await claimCallFinalization(1, { outcome: "busy" }, first), false);
      const row = (await clients[0].query(`select outcome, finalized_at from call_logs where id = 1`)).rows[0];
      assert.equal(row.outcome, winner);
      assert.ok(row.finalized_at instanceof Date);
    } finally {
      if (created) await clients[0].query(`drop schema "${namespace}" cascade`);
      await Promise.allSettled(clients.map((client) => client.end()));
    }
  },
);
