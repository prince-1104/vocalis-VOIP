import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  applyCampaignCallOutcome,
  claimNextCampaignContact,
  reconcileCampaignDispatches,
} from "../src/lib/campaign-dialer";
import { claimCallFinalization } from "../src/lib/transfer-slots";
import { addSuppression, assertDialAllowed, DialBlockedError } from "../src/lib/call-suppression";
import * as schema from "./fake-db";

const configured = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL: campaign claims, finalization and suppressions hold across independent connections",
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
    const namespace = "dialog_campaign_" + randomUUID().replaceAll("-", "");
    let created = false;
    try {
      await Promise.all(clients.map((client) => client.connect()));
      await clients[0].query(`create schema "${namespace}"`);
      created = true;
      await Promise.all(
        clients.map((client) => client.query(`set search_path to "${namespace}"`)),
      );
      // The real migration chain, including 0007's columns, indexes and backfills.
      for (const file of [
        "0000_gorgeous_chronomancer.sql",
        "0001_hot_christian_walker.sql",
        "0002_call_media_sessions.sql",
        "0003_widget_customer_verification.sql",
        "0004_widget_verification_policies.sql",
        "0005_twilio_webhook_idempotency.sql",
        "0006_api_rate_limits.sql",
        "0007_campaign_dispatch_and_suppression.sql",
      ]) {
        const ddl = await readFile(path.resolve("../../lib/db/drizzle", file), "utf8");
        for (const statement of ddl.replaceAll('"public".', "").split("--> statement-breakpoint"))
          if (statement.trim()) await clients[0].query(statement);
      }
      const q = (text: string) => clients[0].query(text);
      await q(`insert into users (id) values (10), (20);
        insert into contacts (id, user_id, first_name, phone) values
          (1, 10, 'Fake', '+15550100001'), (2, 10, 'Fake', '+15550100002'), (3, 10, 'Fake', '+15550100003'),
          (4, 10, 'Fake', '+15550100004'), (5, 10, 'Fake', '+15550100005'), (9, 20, 'Fake', '+15550100009');
        insert into campaigns (id, user_id, name, status, dial_parallel, max_concurrent_calls, max_retries, start_time, end_time, timezone) values
          (1, 10, 'Parallel', 'active', true, 2, 1, '00:00', '23:59', 'UTC'),
          (2, 10, 'Single', 'active', false, 1, 1, '00:00', '23:59', 'UTC');
        insert into campaign_contacts (id, campaign_id, contact_id, created_at) values
          (1, 1, 1, now() - interval '5 minutes'), (2, 1, 2, now() - interval '4 minutes'),
          (3, 1, 3, now() - interval '3 minutes'), (4, 1, 4, now() - interval '2 minutes'),
          (5, 1, 9, now() - interval '6 minutes'), (6, 2, 5, now());`);
      const connections = clients.map((client) => drizzle(client, { schema }) as any);
      // A fixed in-window instant keeps the 23:59 close and safety margin out of play.
      const noon = new Date();
      noon.setUTCHours(12, 0, 0, 0);

      // Four workers claim concurrently against a 2-call limit: exactly two
      // distinct contacts, the other tenant's contact is never claimed.
      const claims = await Promise.all(connections.map((c) => claimNextCampaignContact(1, 10, noon, c)));
      const won = claims.filter((r) => r.kind === "claimed") as Extract<(typeof claims)[number], { kind: "claimed" }>[];
      assert.equal(won.length, 2);
      assert.equal(new Set(won.map((r) => r.claim.linkId)).size, 2);
      assert.ok(claims.filter((r) => r.kind !== "claimed").every((r) => r.kind === "slots_full"));
      const dialing = await q(`select id, attempts from campaign_contacts where status = 'dialing' order by id`);
      assert.deepEqual(dialing.rows.map((r: any) => r.attempts), [1, 1]);
      assert.equal((await q(`select status from campaign_contacts where id = 5`)).rows[0].status, "invalid_contact");

      // Single-slot campaign: one winner among four concurrent claimers.
      const single = await Promise.all(connections.map((c) => claimNextCampaignContact(2, 10, noon, c)));
      assert.equal(single.filter((r) => r.kind === "claimed").length, 1);

      // Concurrent terminal outcomes for one attempt: one transition, one increment.
      await q(`insert into call_logs (id, user_id, campaign_id, contact_id, phone, call_sid, started_at)
        values (100, 10, 2, 5, '+15550100005', 'fake-call-100', now());
        update campaign_contacts set status = 'calling', call_log_id = 100 where id = 6;`);
      const log = { id: 100, userId: 10, campaignId: 2 };
      const applied = await Promise.all(connections.map((c) => applyCampaignCallOutcome(log, "answered", new Date(), c)));
      assert.equal(applied.filter(Boolean).length, 1);
      assert.equal((await q(`select answered_count from campaigns where id = 2`)).rows[0].answered_count, 1);
      assert.equal((await q(`select status from campaign_contacts where id = 6`)).rows[0].status, "answered");
      // Another tenant's id on the call log never advances this campaign.
      assert.equal(await applyCampaignCallOutcome({ ...log, userId: 20 }, "answered", new Date(), connections[0]), false);

      // Reconciliation racing a late status callback: single finalization and transition.
      const [a, b] = won.map((r) => r.claim);
      await q(`insert into call_logs (id, user_id, campaign_id, contact_id, phone, started_at)
        values (101, 10, 1, ${a.contact.id}, '+15550100001', now() - interval '2 hours');
        update campaign_contacts set status = 'dispatch_unknown', call_log_id = 101, claimed_at = now() - interval '2 hours' where id = ${a.linkId};`);
      const results = await Promise.all([
        reconcileCampaignDispatches(1, new Date(), connections[0]).then(() => "reconciled"),
        claimCallFinalization(101, { outcome: "answered", duration: 20 }, connections[1]).then(async (wonFinal) => {
          if (wonFinal) await applyCampaignCallOutcome({ id: 101, userId: 10, campaignId: 1 }, "answered", new Date(), connections[1]);
          return wonFinal;
        }),
      ]);
      const finalRow = (await q(`select outcome, finalized_at from call_logs where id = 101`)).rows[0];
      const link = (await q(`select status from campaign_contacts where id = ${a.linkId}`)).rows[0];
      assert.ok(finalRow.finalized_at instanceof Date);
      assert.equal(link.status, finalRow.outcome === "answered" ? "answered" : "retrying");
      assert.equal(results[1], finalRow.outcome === "answered");

      // A stale claim (worker crashed before creating a call log) is released once.
      await q(`update campaign_contacts set claimed_at = now() - interval '10 minutes' where id = ${b.linkId}`);
      await Promise.all(connections.map((c) => reconcileCampaignDispatches(1, new Date(), c)));
      const released = (await q(`select status, attempts, claim_token from campaign_contacts where id = ${b.linkId}`)).rows[0];
      assert.deepEqual([released.status, released.attempts, released.claim_token], ["pending", 0, null]);

      // Concurrent opt-outs for formatting variants of one number: one record.
      await Promise.all(["+1 555 010 0003", "15550100003", "+15550100003", "(555) 010-0003"].map((phone, i) =>
        addSuppression(10, phone, "opt_out", "crm_api", connections[i])));
      assert.equal((await q(`select count(*)::int as n from call_suppressions`)).rows[0].n, 1);
      await assert.rejects(assertDialAllowed(10, "+1-555-010-0003", connections[2]), (err: any) =>
        err instanceof DialBlockedError && err.code === "suppressed");
      await assertDialAllowed(20, "+15550100003", connections[3]);

      // 0007 backfill: the old implicit default is migrated, explicit zones are kept.
      await q(`insert into campaigns (id, user_id, name, timezone) values (3, 10, 'Legacy', 'America/New_York'), (4, 10, 'Explicit', 'Europe/London')`);
      await q(`UPDATE "campaigns" SET "timezone" = 'Asia/Kolkata' WHERE "timezone" IS NULL OR "timezone" = 'America/New_York'`);
      const zones = (await q(`select id, timezone from campaigns where id in (3, 4) order by id`)).rows.map((r: any) => r.timezone);
      assert.deepEqual(zones, ["Asia/Kolkata", "Europe/London"]);
      assert.equal((await q(`insert into campaigns (id, user_id, name) values (5, 10, 'Default') returning timezone`)).rows[0].timezone, "Asia/Kolkata");
    } finally {
      if (created) await clients[0].query(`drop schema "${namespace}" cascade`);
      await Promise.allSettled(clients.map((client) => client.end()));
    }
  },
);
