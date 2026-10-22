-- Columns that exist in the schema snapshots (and in push-managed databases) but were never
-- emitted by earlier migration SQL; required below. No-ops where they already exist.
ALTER TABLE "campaign_contacts" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "dial_parallel" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "is_automatic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "max_retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "retry_interval_minutes" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "transfer_config" jsonb;--> statement-breakpoint
CREATE TABLE "call_suppressions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"phone_key" text NOT NULL,
	"phone" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "timezone" SET DEFAULT 'Asia/Kolkata';--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD COLUMN "claim_token" text;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD COLUMN "claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD COLUMN "call_log_id" integer;--> statement-breakpoint
ALTER TABLE "call_suppressions" ADD CONSTRAINT "call_suppressions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "call_suppressions_user_phone_key_unique" ON "call_suppressions" USING btree ("user_id","phone_key");--> statement-breakpoint
CREATE INDEX "campaign_contacts_campaign_status_idx" ON "campaign_contacts" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "campaign_contacts_call_log_idx" ON "campaign_contacts" USING btree ("call_log_id");--> statement-breakpoint
-- Dashboard campaigns never set a time zone, so America/New_York rows carry the old column default.
UPDATE "campaigns" SET "timezone" = 'Asia/Kolkata' WHERE "timezone" IS NULL OR "timezone" = 'America/New_York';--> statement-breakpoint
-- Bind in-flight legacy attempts to their latest call log so reconciliation can resolve them.
UPDATE "campaign_contacts" AS cc SET
	"call_log_id" = (
		SELECT cl."id" FROM "call_logs" AS cl
		WHERE cl."campaign_id" = cc."campaign_id" AND cl."contact_id" = cc."contact_id"
		ORDER BY cl."started_at" DESC LIMIT 1
	),
	"claimed_at" = COALESCE(cc."last_attempt_at", now())
WHERE cc."status" = 'calling';