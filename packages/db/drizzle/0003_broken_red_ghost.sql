ALTER TABLE "credentials" ALTER COLUMN "value_plaintext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "value_encrypted" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "encryption_key_id" text DEFAULT 'v1';--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "rate_limit_count" integer DEFAULT 0 NOT NULL;