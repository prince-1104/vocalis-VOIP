CREATE TABLE "rate_limit_counters" (
	"bucket_key" text NOT NULL,
	"window_start" bigint NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_counters_bucket_key_window_start_pk" PRIMARY KEY("bucket_key","window_start")
);
--> statement-breakpoint
CREATE INDEX "rate_limit_counters_expires_idx" ON "rate_limit_counters" USING btree ("expires_at");
