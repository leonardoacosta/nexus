-- Spec: credentials-account-resolve-and-usage
--
-- Adds the latest-usage snapshot columns the new
-- `credential-usage-poller.ts` writes every 5 minutes per primary credential.
-- Source upstream: Anthropic `/api/oauth/usage` response
--   { five_hour: { used, limit, resets_at }, seven_day: { ... } }
--
-- All NULL until the poller's first successful sample for a given row.
-- Adding seven NULLABLE columns is a metadata-only change at this scale
-- (~50 rows), so no rewrite cost on live homelab DBs.

ALTER TABLE "credentials" ADD COLUMN "usage_5h_used" integer;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "usage_5h_limit" integer;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "usage_5h_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "usage_7d_used" integer;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "usage_7d_limit" integer;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "usage_7d_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "usage_polled_at" timestamp with time zone;
