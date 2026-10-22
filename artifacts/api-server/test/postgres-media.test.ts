import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresMediaSessionStore } from "../src/lib/media-session";
import * as schema from "./fake-db";

const configured = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL: independent connections claim once; reconnect cannot replay",
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
    const namespace = "dialog_security_" + randomUUID().replaceAll("-", "");
    let created = false;
    try {
      await Promise.all(clients.map((client) => client.connect()));
      await clients[0].query(`create schema "${namespace}"`);
      created = true;
      await Promise.all(
        clients.map((client) =>
          client.query(`set search_path to "${namespace}"`),
        ),
      );
      await clients[0].query(`create table users (id integer primary key);
      create table tenants (id integer primary key, owner_id integer, status text, telephony_type text);
      create table agent_configs (user_id integer, twilio_account_sid text);
      create table call_logs (id integer primary key, user_id integer, call_sid text, ended_at timestamp);
      insert into users values (10); insert into tenants values (1,10,'active','TWILIO');
      insert into agent_configs values (10,'ACfake'); insert into call_logs values (1,10,'CAfake',null);`);
      await clients[0].query(
        await readFile(
          path.resolve("../../lib/db/drizzle/0002_call_media_sessions.sql"),
          "utf8",
        ),
      );
      const first = createPostgresMediaSessionStore(
        drizzle(clients[0], { schema }) as any,
      );
      const second = createPostgresMediaSessionStore(
        drizzle(clients[1], { schema }) as any,
      );
      const row: any = {
        id: randomUUID(),
        credentialHash: "fake-hash",
        callLogId: 1,
        tenantId: 1,
        ownerId: 10,
        provider: "twilio",
        accountSid: "ACfake",
        callSid: "CAfake",
        expiresAt: new Date(Date.now() + 120_000),
        state: "pending",
        streamSid: null,
        createdAt: new Date(),
        claimedAt: null,
        closedAt: null,
      };
      await first.insert(row);
      const result = await Promise.all([
        first.claim(row, "MZfirst", new Date()),
        second.claim(row, "MZsecond", new Date()),
      ]);
      assert.equal(result.filter(Boolean).length, 1);
      await clients[1].end();
      clients[1] = new Client({ connectionString: configured });
      await clients[1].connect();
      await clients[1].query(`set search_path to "${namespace}"`);
      const reconnected = createPostgresMediaSessionStore(
        drizzle(clients[1], { schema }) as any,
      );
      assert.equal(await reconnected.claim(row, "MZreplay", new Date()), false);
      assert.equal(await first.close(row.id), true);
      assert.equal(await reconnected.close(row.id), false);
    } finally {
      if (created) await clients[0].query(`drop schema "${namespace}" cascade`);
      await Promise.allSettled(clients.map((client) => client.end()));
    }
  },
);
