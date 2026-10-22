CREATE TABLE "billing_rate_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"rates" jsonb NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_rate_cards_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "budget_reservations" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"period" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"source" text NOT NULL,
	"call_log_id" integer,
	"amount" numeric(14, 8) NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"release_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoice_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"raw_amount_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"billed_amount_usd" numeric(10, 6) NOT NULL,
	"reason" text NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_budget_periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"period" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"committed_amount" numeric(14, 8) DEFAULT '0' NOT NULL,
	"reserved_amount" numeric(14, 8) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"call_log_id" integer,
	"session_ref" text,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"provider_request_id" text,
	"idempotency_key" text NOT NULL,
	"entry_type" text DEFAULT 'usage' NOT NULL,
	"adjusts_entry_id" integer,
	"measurement" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" numeric(18, 6),
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_input_tokens" integer,
	"billed_units" numeric(18, 6),
	"rate_card_id" integer,
	"rate_version" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"provider_cost" numeric(14, 8),
	"provider_cost_currency" text,
	"platform_cost" numeric(14, 8),
	"commission_pct" numeric(5, 2),
	"billable_amount" numeric(14, 8),
	"budget_amount" numeric(14, 8) DEFAULT '0' NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"invoice_id" integer,
	"metadata" jsonb,
	"revision" integer DEFAULT 0 NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "usage_count" integer;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "estimated" boolean;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "source" text DEFAULT 'call_logs' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "rate_versions" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "usage_summary" jsonb;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_call_log_id_call_logs_id_fk" FOREIGN KEY ("call_log_id") REFERENCES "public"."call_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_budget_periods" ADD CONSTRAINT "tenant_budget_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_call_log_id_call_logs_id_fk" FOREIGN KEY ("call_log_id") REFERENCES "public"."call_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_rate_card_id_billing_rate_cards_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."billing_rate_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_reservations_tenant_key_idx" ON "budget_reservations" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "budget_reservations_held_idx" ON "budget_reservations" USING btree ("tenant_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "budget_reservations_call_log_idx" ON "budget_reservations" USING btree ("call_log_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_budget_periods_tenant_period_idx" ON "tenant_budget_periods" USING btree ("tenant_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledger_tenant_idempotency_idx" ON "usage_ledger" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "usage_ledger_tenant_event_idx" ON "usage_ledger" USING btree ("tenant_id","event_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_call_log_idx" ON "usage_ledger" USING btree ("call_log_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_status_idx" ON "usage_ledger" USING btree ("status");--> statement-breakpoint
CREATE INDEX "usage_ledger_invoice_idx" ON "usage_ledger" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_ledger_tenant_period_idx" ON "invoices" USING btree ("tenant_id","period") WHERE source = 'ledger';--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_status_check" CHECK ("status" IN ('pending', 'finalized', 'failed', 'needs_reconciliation'));--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_measurement_check" CHECK ("measurement" IN ('actual', 'estimated', 'unknown'));--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_category_check" CHECK ("category" IN ('llm', 'stt', 'tts', 'telephony'));--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_entry_type_check" CHECK ("entry_type" IN ('usage', 'adjustment'));--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_currency_check" CHECK ("currency" IN ('USD', 'INR'));--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_priced_check" CHECK ("status" <> 'finalized' OR ("platform_cost" IS NOT NULL AND "rate_version" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_status_check" CHECK ("status" IN ('held', 'released'));--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_amount_check" CHECK ("amount" >= 0);--> statement-breakpoint
ALTER TABLE "tenant_budget_periods" ADD CONSTRAINT "tenant_budget_periods_reserved_check" CHECK ("reserved_amount" >= 0);--> statement-breakpoint
CREATE OR REPLACE FUNCTION billing_rate_cards_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'billing_rate_cards rows are immutable';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER billing_rate_cards_no_update BEFORE UPDATE OR DELETE ON "billing_rate_cards" FOR EACH ROW EXECUTE FUNCTION billing_rate_cards_immutable();