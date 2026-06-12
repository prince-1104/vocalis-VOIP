CREATE TABLE "crm_agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"crm_agent_id" text NOT NULL,
	"name" text NOT NULL,
	"specialization" text,
	"phone" text,
	"sip_uri" text,
	"intents" jsonb DEFAULT '[]'::jsonb,
	"is_available" boolean DEFAULT true NOT NULL,
	"max_concurrent_calls" integer DEFAULT 3 NOT NULL,
	"current_calls" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"name" text NOT NULL,
	"scopes" jsonb DEFAULT '["calls:read","calls:write"]'::jsonb,
	"webhook_url" text,
	"webhook_secret" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "crm_api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"api_key_id" integer NOT NULL,
	"call_id" integer,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_attempt_at" timestamp,
	"response_status" integer,
	"response_body" text,
	"next_retry_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intent_training" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"intent" text NOT NULL,
	"training_content" text NOT NULL,
	"max_turns" integer DEFAULT 8 NOT NULL,
	"auto_transfer" boolean DEFAULT true NOT NULL,
	"transfer_to" text,
	"crm_agent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_configs" ADD COLUMN "widget_voice_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD COLUMN "twilio_twiml_app_sid" text;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN "crm_contact_id" text;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN "crm_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN "call_sid" text;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN "conference_sid" text;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN "transferred_to" text;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN "transfer_reason" text;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN "transferred_at" timestamp;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN "live_transcript" jsonb;--> statement-breakpoint
ALTER TABLE "crm_agents" ADD CONSTRAINT "crm_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_api_keys" ADD CONSTRAINT "crm_api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_api_keys" ADD CONSTRAINT "crm_api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_api_key_id_crm_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."crm_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_call_id_call_logs_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."call_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_training" ADD CONSTRAINT "intent_training_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_agents_user_idx" ON "crm_agents" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_agents_user_crm_id_unique" ON "crm_agents" USING btree ("user_id","crm_agent_id");--> statement-breakpoint
CREATE INDEX "crm_api_keys_user_idx" ON "crm_api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "crm_api_keys_tenant_idx" ON "crm_api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_api_key_idx" ON "webhook_deliveries" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_retry_idx" ON "webhook_deliveries" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_call_idx" ON "webhook_deliveries" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intent_training_user_intent_unique" ON "intent_training" USING btree ("user_id","intent");--> statement-breakpoint
CREATE INDEX "intent_training_user_idx" ON "intent_training" USING btree ("user_id");