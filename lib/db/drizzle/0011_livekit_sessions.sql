CREATE TABLE IF NOT EXISTS "livekit_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"provider_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "livekit_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"owner_id" integer NOT NULL,
	"member_id" integer NOT NULL,
	"auth_session_id" integer NOT NULL,
	"call_log_id" integer,
	"mode" text NOT NULL,
	"room" text NOT NULL,
	"participant" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"worker_id" text,
	"claim_hash" text,
	"lease_until" timestamp with time zone,
	"admission_until" timestamp with time zone NOT NULL,
	"active_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "livekit_sessions_room_unique" UNIQUE("room"),
	CONSTRAINT "livekit_sessions_participant_unique" UNIQUE("participant")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "livekit_trunks" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"provider" text NOT NULL,
	"trunk_id" text NOT NULL,
	"dispatch_rule_id" text,
	"state" text DEFAULT 'unverified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "livekit_trunks_trunk_id_unique" UNIQUE("trunk_id")
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "livekit_operations" ADD CONSTRAINT "livekit_operations_session_id_livekit_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."livekit_sessions"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "livekit_sessions" ADD CONSTRAINT "livekit_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "livekit_sessions" ADD CONSTRAINT "livekit_sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "livekit_sessions" ADD CONSTRAINT "livekit_sessions_member_id_tenant_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."tenant_users"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "livekit_sessions" ADD CONSTRAINT "livekit_sessions_auth_session_id_tenant_sessions_id_fk" FOREIGN KEY ("auth_session_id") REFERENCES "public"."tenant_sessions"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "livekit_sessions" ADD CONSTRAINT "livekit_sessions_call_log_id_call_logs_id_fk" FOREIGN KEY ("call_log_id") REFERENCES "public"."call_logs"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "livekit_trunks" ADD CONSTRAINT "livekit_trunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "livekit_one_preview_per_tenant" ON "livekit_sessions" USING btree ("tenant_id") WHERE "livekit_sessions"."call_log_id" is null and "livekit_sessions"."state" in ('pending','active');