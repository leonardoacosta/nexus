ALTER TABLE "credentials" ADD COLUMN "fingerprint" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "duplicate_group_id" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "credentials_fingerprint_idx" ON "credentials" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "credentials_group_primary_idx" ON "credentials" USING btree ("duplicate_group_id","is_primary");