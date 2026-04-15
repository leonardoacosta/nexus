ALTER TABLE "credentials" ADD COLUMN "subscription_type" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "rate_limit_tier" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "expires_at" timestamp with time zone;