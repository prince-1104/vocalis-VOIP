CREATE TABLE "widget_verification_policies" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "method" text DEFAULT 'order_suffix_4' NOT NULL,
  "dob_field_path" text,
  "dob_format" text,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by_tenant_user_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "widget_verification_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "widget_verification_policies_updated_by_tenant_user_id_tenant_users_id_fk" FOREIGN KEY ("updated_by_tenant_user_id") REFERENCES "tenant_users"("id") ON DELETE SET NULL,
  CONSTRAINT "widget_verification_policies_method_check" CHECK ("widget_verification_policies"."method" in ('order_suffix_4', 'order_suffix_6', 'date_of_birth', 'sms_otp')),
  CONSTRAINT "widget_verification_policies_dob_format_check" CHECK ("widget_verification_policies"."dob_format" is null or "widget_verification_policies"."dob_format" in ('YYYY-MM-DD', 'DD-MM-YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY')),
  CONSTRAINT "widget_verification_policies_dob_config_check" CHECK ("widget_verification_policies"."method" <> 'date_of_birth' or ("widget_verification_policies"."dob_field_path" is not null and "widget_verification_policies"."dob_format" is not null)),
  CONSTRAINT "widget_verification_policies_version_check" CHECK ("widget_verification_policies"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "widget_verification_policies_tenant_id_unique" ON "widget_verification_policies" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "widget_verification_challenges" ADD COLUMN "method" text DEFAULT 'sms_otp' NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_verification_challenges" ADD COLUMN "policy_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_customer_sessions" ADD COLUMN "method" text DEFAULT 'sms_otp' NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_customer_sessions" ADD COLUMN "policy_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_customer_sessions" ADD COLUMN "scope" text DEFAULT 'customer' NOT NULL;
