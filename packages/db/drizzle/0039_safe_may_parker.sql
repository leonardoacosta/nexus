CREATE TABLE "credential_swaps" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"from_fingerprint" text,
	"to_fingerprint" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "credential_swaps_session_created_at_idx" ON "credential_swaps" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "credential_swaps_created_at_idx" ON "credential_swaps" USING btree ("created_at");