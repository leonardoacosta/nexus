-- Custom SQL migration file, put your code below! --

-- Spec: add-cc-credential-manager
-- 1. RENAME credential_events -> cc_profile_events (and rename credential_id -> profile_id).
-- 2. CREATE TABLE cc_profiles for active Claude OAuth profile tracking.

ALTER TABLE "credential_events" RENAME TO "cc_profile_events";
--> statement-breakpoint
ALTER TABLE "cc_profile_events" RENAME COLUMN "credential_id" TO "profile_id";
--> statement-breakpoint
ALTER INDEX "credential_events_credential_created_at_idx"
    RENAME TO "cc_profile_events_profile_created_at_idx";
--> statement-breakpoint
ALTER INDEX "credential_events_created_at_idx"
    RENAME TO "cc_profile_events_created_at_idx";
--> statement-breakpoint
CREATE TABLE "cc_profiles" (
    "id" text PRIMARY KEY NOT NULL,
    "type" text NOT NULL,
    "oauth_refresh_token_encrypted" text,
    "encryption_key_id" text DEFAULT 'v1',
    "expiry_ts" timestamp with time zone,
    "last_used_ts" timestamp with time zone,
    "current_cost_usd" double precision DEFAULT 0 NOT NULL,
    "rate_limit_status" text DEFAULT 'healthy' NOT NULL,
    "account_email" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cc_profiles_expiry_ts_idx" ON "cc_profiles" USING btree ("expiry_ts");
--> statement-breakpoint
CREATE INDEX "cc_profiles_rate_limit_status_idx" ON "cc_profiles" USING btree ("rate_limit_status");