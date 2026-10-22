import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableColumns } from "drizzle-orm";
import {
  createWidgetVerification,
  MAX_ATTEMPTS,
  type VerificationCodeMessage,
} from "../src/lib/widget-verification";
import * as schema from "./fake-db";

const configured = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL: widget challenges consume once and cap attempts across connections",
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
        clients.map((client) => client.query(`set search_path to "${namespace}"`)),
      );
      const tenantColumns = Object.values(getTableColumns(schema.tenantsTable))
        .map((c: any) => c.name)
        .filter((name) => !["id", "owner_id"].includes(name))
        .map((name) => `"${name}" text`)
        .join(", ");
      await clients[0].query(`create table users (id integer primary key);
      create table agent_configs (id integer primary key);
      create table tenant_users (id integer primary key);
      create table tenants (id integer primary key, owner_id integer, ${tenantColumns});
      insert into users values (10); insert into agent_configs values (1);
      insert into tenants (id, owner_id, status) values (1, 10, 'active');`);
      for (const file of ["0003_widget_customer_verification.sql", "0004_widget_verification_policies.sql"])
        for (const statement of (
          await readFile(path.resolve("../../lib/db/drizzle", file), "utf8")
        ).split("--> statement-breakpoint"))
          await clients[0].query(statement);
      await assert.rejects(
        clients[0].query(`insert into widget_verification_policies (tenant_id, enabled, method) values (1, true, 'date_of_birth')`),
        /widget_verification_policies_dob_config_check/,
      );
      await assert.rejects(
        clients[0].query(`insert into widget_verification_policies (tenant_id, method) values (1, 'anything')`),
        /widget_verification_policies_method_check/,
      );
      await clients[0].query(`insert into widget_verification_policies (tenant_id, enabled) values (1, true)`);
      await assert.rejects(
        clients[0].query(`insert into widget_verification_policies (tenant_id) values (1)`),
        /widget_verification_policies_tenant_id_unique/,
      );
      const sent: VerificationCodeMessage[] = [];
      const pending: Promise<void>[] = [];
      const lookupCustomer = (async () => ({
        found: true,
        orders: [{ orderId: "ORD-0001234" }],
        context: { fetchedAt: "", customerFound: true },
      })) as any;
      const services = clients.map((client) =>
        createWidgetVerification({
          db: drizzle(client, { schema }) as any,
          sender: { send: async (m) => void sent.push(m) },
          isEligible: async () => true,
          lookupCustomer,
          schedule: (task) => void pending.push(task()),
        }),
      );
      const agent = { id: 1, userId: 10 };
      const apiKey = "wk_fake_" + "a".repeat(40);
      const policy = { tenantId: 1, version: 1, method: "sms_otp" as const, dobFieldPath: null, dobFormat: null };
      const issue = async (phone: string) => {
        const started = await services[0].start({ agent, apiKey, phone, source: "127.0.0.1", policy });
        assert.ok(started.ok);
        await Promise.all(pending.splice(0));
        return { challengeId: started.challengeId, code: sent.at(-1)!.code };
      };
      const first = await issue("9000000001");
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          services[i % 2].verify({ agent, apiKey, policy, ...first }),
        ),
      );
      assert.equal(results.filter((r) => r.ok).length, 1);
      const second = await issue("9000000002");
      await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          services[i % 2].verify({
            agent,
            apiKey,
            policy,
            challengeId: second.challengeId,
            code: String((Number(second.code) + 1 + i) % 1_000_000).padStart(6, "0"),
          }),
        ),
      );
      const { rows } = await clients[0].query(
        "select id, attempts from widget_verification_challenges",
      );
      for (const row of rows) assert.ok(row.attempts <= MAX_ATTEMPTS);
      const wrongCode = String((Number(second.code) + 500) % 1_000_000).padStart(6, "0");
      for (let i = 0; i < MAX_ATTEMPTS; i++)
        await services[i % 2].verify({ agent, apiKey, policy, challengeId: second.challengeId, code: wrongCode });
      assert.equal(
        (await services[1].verify({ agent, apiKey, policy, ...second })).ok,
        false,
        "correct code after the attempt cap",
      );
      const sessions = await clients[0].query(
        "select challenge_id from widget_customer_sessions",
      );
      assert.equal(sessions.rows.length, 1);

      // Knowledge factors share the same single-winner and attempt-cap guarantees.
      const suffix = { ...policy, method: "order_suffix_4" as const };
      const started = await services[0].start({ agent, apiKey, phone: "9000000003", source: "127.0.0.2", policy: suffix });
      assert.ok(started.ok);
      const digitResults = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          services[i % 2].verify({
            agent,
            apiKey,
            policy: suffix,
            challengeId: started.challengeId,
            orderDigits: i % 3 === 0 ? "1234" : String(4000 + i),
          }),
        ),
      );
      assert.ok(digitResults.filter((r) => r.ok).length <= 1);
      const challengeRow = await clients[0].query(
        "select attempts, method, policy_version from widget_verification_challenges where id = $1",
        [started.challengeId],
      );
      assert.ok(challengeRow.rows[0].attempts <= MAX_ATTEMPTS);
      assert.deepEqual([challengeRow.rows[0].method, challengeRow.rows[0].policy_version], ["order_suffix_4", 1]);
      const scoped = await clients[0].query(
        "select scope, active_order_id from widget_customer_sessions where challenge_id = $1",
        [started.challengeId],
      );
      for (const row of scoped.rows) assert.deepEqual([row.scope, row.active_order_id], ["order", "ORD-0001234"]);
    } finally {
      if (created) await clients[0].query(`drop schema "${namespace}" cascade`);
      await Promise.allSettled(clients.map((client) => client.end()));
    }
  },
);
