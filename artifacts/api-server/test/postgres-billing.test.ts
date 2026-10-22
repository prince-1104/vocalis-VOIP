import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { rows } from "./fake-db";
import * as schema from "./fake-db";
import { invalidateRateCard } from "../src/lib/billing/rate-card";
import { getBudgetState, releaseReservation, reserveBudget, billingPeriod } from "../src/lib/billing/spend-budget";
import { recordUsage } from "../src/lib/billing/usage-ledger";
import { generateLedgerInvoice, InvoiceError } from "../src/lib/billing/invoicing";

const configured = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL: hard budgets, usage idempotency and invoice claims hold across independent connections",
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
    // One client per concurrent operation: transactions issued concurrently on a
    // single pg Client share one session (like production's Pool, each needs its own).
    const clients = Array.from({ length: 8 }, () => new Client({ connectionString: configured }));
    const namespace = "dialog_billing_" + randomUUID().replaceAll("-", "");
    let created = false;
    try {
      await Promise.all(clients.map((client) => client.connect()));
      await clients[0].query(`create schema "${namespace}"`);
      created = true;
      await Promise.all(
        clients.map((client) => client.query(`set search_path to "${namespace}"`)),
      );
      // The real migration chain alone: 0008's ledger tables, indexes and trigger,
      // and 0009's tenants.telephony_type, which the ledger's tenant read requires.
      for (const file of [
        "0000_gorgeous_chronomancer.sql",
        "0001_hot_christian_walker.sql",
        "0002_call_media_sessions.sql",
        "0003_widget_customer_verification.sql",
        "0004_widget_verification_policies.sql",
        "0005_twilio_webhook_idempotency.sql",
        "0006_api_rate_limits.sql",
        "0007_campaign_dispatch_and_suppression.sql",
        "0008_usage_ledger_and_budgets.sql",
        "0009_schema_reconciliation.sql",
      ]) {
        const ddl = await readFile(path.resolve("../../lib/db/drizzle", file), "utf8");
        for (const statement of ddl.replaceAll('"public".', "").split("--> statement-breakpoint"))
          if (statement.trim()) await clients[0].query(statement);
      }
      const q = (text: string) => clients[0].query(text);
      await q(`insert into users (id) values (10), (20);
        insert into tenants (id, name, slug, owner_id, commission_pct) values (1, 'Fake tenant', 'fake', 10, 20), (2, 'Fake tenant B', 'fake-b', 20, 0);
        insert into tenant_limits (tenant_id, monthly_limit_usd, hard_limit) values (1, 0.10, true);`);
      // Owner-to-tenant resolution is a read through the application's default
      // connection; every write and lock under test goes through `connections`.
      rows.tenants = [{ id: 1, ownerId: 10 }, { id: 2, ownerId: 20 }];
      invalidateRateCard();
      const connections = clients.map((client) => drizzle(client, { schema }) as any);
      const period = billingPeriod();

      // Eight concurrent 0.03 holds against a 0.10 hard limit: exactly three fit.
      const holds = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
        reserveBudget({ userId: 10, key: `hold-${i}`, amount: 0.03, source: "test", ttlMs: 60_000 }, connections[i])));
      const won = holds.filter((r) => r.status === "fulfilled");
      assert.equal(won.length, 3);
      assert.ok(holds.filter((r) => r.status === "rejected").every((r: any) => r.reason.code === "spend_limit"));
      const state = await getBudgetState(1, connections[0]);
      assert.ok(Math.abs(state.reservedUsd - 0.09) < 1e-9);
      assert.equal((await q(`select count(*)::int as n from budget_reservations where status = 'held'`)).rows[0].n, 3);
      // Tenant A's exhausted hard limit does not affect tenant B, which has no limit row.
      const other = await Promise.all(Array.from({ length: 4 }, (_, i) =>
        reserveBudget({ userId: 20, key: `hold-${i}`, amount: 0.03, source: "test", ttlMs: 60_000 }, connections[i])));
      assert.equal(other.length, 4);
      assert.ok(Math.abs((await getBudgetState(2, connections[0])).reservedUsd - 0.12) < 1e-9);
      assert.ok(Math.abs((await getBudgetState(1, connections[0])).reservedUsd - 0.09) < 1e-9);
      await Promise.all(other.map((hold, i) => releaseReservation(2, hold.key, "test", connections[i])));

      // Concurrent releases of one hold: a single winner adjusts the counter.
      const heldKey = (await q(`select idempotency_key from budget_reservations where status = 'held' limit 1`)).rows[0].idempotency_key;
      const releases = await Promise.all(connections.map((c) => releaseReservation(1, heldKey, "test", c)));
      assert.equal(releases.filter(Boolean).length, 1);
      assert.ok(Math.abs((await getBudgetState(1, connections[0])).reservedUsd - 0.06) < 1e-9);
      await q(`update tenant_limits set hard_limit = false`);

      // The same usage reported concurrently (an estimate racing three actual reports) is stored once.
      const usage = (measurement: "estimated" | "actual", outputTokens: number) => ({
        userId: 10, source: "test", category: "llm" as const, provider: "openai", model: "gpt-4o-mini",
        idempotencyKey: "llm:race", measurement, unit: "tokens" as const,
        quantity: 1000 + outputTokens, inputTokens: 1000, outputTokens,
      });
      await Promise.all([
        recordUsage(usage("estimated", 900), connections[0]),
        recordUsage(usage("actual", 500), connections[1]),
        recordUsage(usage("actual", 500), connections[2]),
        recordUsage(usage("actual", 500), connections[3]),
      ]);
      const entries = (await q(`select measurement, platform_cost, budget_amount from usage_ledger where idempotency_key = 'llm:race'`)).rows;
      assert.equal(entries.length, 1);
      assert.equal(entries[0].measurement, "actual");
      const actualCost = (1000 * 0.15 + 500 * 0.6) / 1e6;
      assert.ok(Math.abs(Number(entries[0].platform_cost) - actualCost) < 1e-9);
      const committed = (await q(`select committed_amount from tenant_budget_periods where tenant_id = 1 and period = '${period}'`)).rows[0].committed_amount;
      assert.ok(Math.abs(Number(committed) - actualCost) < 1e-9, "the estimate is not counted in addition to the actual");

      // Tenant B: the same idempotency key is a separate identity, retries race to one row,
      // and an ambiguous (5xx) entry reconciled by concurrent late reports is charged once.
      await Promise.all(connections.map((c) => recordUsage({ ...usage("actual", 500), userId: 20 }, c)));
      const tts = (outcome: "unknown" | "charged") => ({
        userId: 20, source: "test", category: "tts" as const, provider: "sarvam", model: "bulbul:v3",
        idempotencyKey: "tts:ambiguous", measurement: "actual" as const, unit: "characters" as const, quantity: 1000, outcome,
      });
      const ambiguous = await recordUsage(tts("unknown"), connections[0]);
      assert.equal(ambiguous.status, "needs_reconciliation");
      await Promise.all(connections.map((c) => recordUsage(tts("charged"), c)));
      const tenantB = (await q(`select idempotency_key, status, revision from usage_ledger where tenant_id = 2 order by idempotency_key`)).rows;
      assert.deepEqual(tenantB.map((r: any) => [r.idempotency_key, r.status]), [["llm:race", "finalized"], ["tts:ambiguous", "finalized"]]);
      assert.equal(tenantB[1].revision, 1, "exactly one late report reconciled the entry");
      const committedB = (await q(`select committed_amount from tenant_budget_periods where tenant_id = 2 and period = '${period}'`)).rows[0].committed_amount;
      assert.ok(Math.abs(Number(committedB) - (((1000 * 0.15 + 500 * 0.6) / 1e6) + 1000 * 3 / 1e6)) < 1e-9);
      assert.ok(Math.abs(Number((await q(`select committed_amount from tenant_budget_periods where tenant_id = 1 and period = '${period}'`)).rows[0].committed_amount) - actualCost) < 1e-9);

      // Concurrent invoice preparation: one invoice claims each entry exactly once.
      const invoices = await Promise.allSettled(connections.map((c) => generateLedgerInvoice({ tenantId: 1, period }, c)));
      assert.equal(invoices.filter((r) => r.status === "fulfilled").length, 1);
      assert.ok(invoices.filter((r) => r.status === "rejected").every((r: any) => r.reason instanceof InvoiceError));
      assert.equal((await q(`select count(*)::int as n from invoices`)).rows[0].n, 1);
      assert.equal((await q(`select count(*)::int as n from invoice_line_items`)).rows[0].n, 1);
      assert.equal((await q(`select count(*)::int as n from usage_ledger where tenant_id = 1 and invoice_id is null`)).rows[0].n, 0);
      assert.equal((await q(`select count(*)::int as n from usage_ledger where tenant_id = 2 and invoice_id is not null`)).rows[0].n, 0, "an invoice never claims another tenant's usage");

      // Rate cards are immutable once written.
      await assert.rejects(q(`update billing_rate_cards set rates = '{}'::jsonb`));
      await assert.rejects(q(`delete from billing_rate_cards`));
    } finally {
      invalidateRateCard();
      if (created) await clients[0].query(`drop schema "${namespace}" cascade`);
      await Promise.allSettled(clients.map((client) => client.end()));
    }
  },
);
