CREATE TABLE IF NOT EXISTS "vobiz_sip_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"sip_domain" text NOT NULL,
	"sip_username" text NOT NULL,
	"sip_password" text NOT NULL,
	"phone_numbers" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vobiz_sip_configs_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vobiz_sip_configs_tenant_id_tenants_id_fk' AND conrelid = 'public.vobiz_sip_configs'::regclass) THEN
    ALTER TABLE "vobiz_sip_configs" ADD CONSTRAINT "vobiz_sip_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
