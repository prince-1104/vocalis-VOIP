CREATE TABLE "widget_verification_challenges" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL,
  "owner_id" integer NOT NULL,
  "agent_config_id" integer NOT NULL,
  "widget_key_hash" text NOT NULL,
  "phone" text NOT NULL,
  "destination_hash" text NOT NULL,
  "source_hash" text NOT NULL,
  "code_hash" text NOT NULL,
  "eligible" boolean,
  "state" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "resend_count" integer DEFAULT 0 NOT NULL,
  "last_sent_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "verified_at" timestamp with time zone,
  CONSTRAINT "widget_verification_challenges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "widget_verification_challenges_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "widget_verification_challenges_agent_config_id_agent_configs_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "agent_configs"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE "widget_customer_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "challenge_id" text NOT NULL,
  "tenant_id" integer NOT NULL,
  "owner_id" integer NOT NULL,
  "agent_config_id" integer NOT NULL,
  "widget_key_hash" text NOT NULL,
  "phone" text NOT NULL,
  "active_order_id" text,
  "state" text DEFAULT 'active' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "widget_customer_sessions_challenge_id_widget_verification_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "widget_verification_challenges"("id") ON DELETE CASCADE,
  CONSTRAINT "widget_customer_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "widget_customer_sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "widget_customer_sessions_agent_config_id_agent_configs_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "agent_configs"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "widget_customer_sessions_token_hash_unique" ON "widget_customer_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "widget_customer_sessions_challenge_id_unique" ON "widget_customer_sessions" USING btree ("challenge_id");--> statement-breakpoint
CREATE INDEX "widget_verification_challenges_destination_idx" ON "widget_verification_challenges" USING btree ("tenant_id","destination_hash","created_at");--> statement-breakpoint
CREATE INDEX "widget_verification_challenges_source_idx" ON "widget_verification_challenges" USING btree ("tenant_id","source_hash","created_at");--> statement-breakpoint
CREATE INDEX "widget_verification_challenges_tenant_idx" ON "widget_verification_challenges" USING btree ("tenant_id","created_at");
