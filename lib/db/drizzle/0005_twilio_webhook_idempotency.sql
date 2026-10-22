ALTER TABLE "call_logs" ADD COLUMN "transfer_agent_id" integer;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN "transfer_released_at" timestamp;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN "finalized_at" timestamp;
