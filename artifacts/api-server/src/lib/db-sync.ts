import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

export async function syncDatabase() {
  try {
    // 1. Ensure api_cost_logs exists
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "api_cost_logs" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" integer NOT NULL,
        "user_id" integer NOT NULL,
        "api_provider" text NOT NULL,
        "input_tokens" integer,
        "output_tokens" integer,
        "characters" integer,
        "minutes" real,
        "cost_usd" numeric(12, 8) DEFAULT '0' NOT NULL,
        "context" text,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    // 2. Ensure tenant_limits exists
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "tenant_limits" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" integer NOT NULL UNIQUE,
        "monthly_limit_usd" numeric(10, 2) DEFAULT '5.00' NOT NULL,
        "hard_limit" boolean DEFAULT false NOT NULL,
        "limit_alert_sent_at" timestamp,
        "alert_month" text,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    // 3. Add columns that might be missing from older schema versions
    const alterQueries = [
      'ALTER TABLE "api_cost_logs" ADD COLUMN IF NOT EXISTS "context" text;',
      'ALTER TABLE "api_cost_logs" ADD COLUMN IF NOT EXISTS "characters" integer;',
      'ALTER TABLE "api_cost_logs" ADD COLUMN IF NOT EXISTS "minutes" real;',
      'ALTER TABLE "api_cost_logs" ADD COLUMN IF NOT EXISTS "user_id" integer DEFAULT 0;',
      'ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "is_automatic" boolean DEFAULT false NOT NULL;'
    ];

    for (const q of alterQueries) {
      try {
        await db.execute(sql.raw(q));
      } catch (e) {
        // Ignore if column exists (though IF NOT EXISTS handles this in newer PG versions)
      }
    }

    logger.info("Database synchronized successfully (api_cost_logs, tenant_limits)");
  } catch (error) {
    logger.error({ error }, "Failed to synchronize database on startup");
  }
}
