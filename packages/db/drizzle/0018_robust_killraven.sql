CREATE TABLE "credential_events" (
	"id" text PRIMARY KEY NOT NULL,
	"credential_id" text NOT NULL,
	"event_type" text NOT NULL,
	"session_id" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "credential_events_credential_created_at_idx" ON "credential_events" USING btree ("credential_id","created_at");--> statement-breakpoint
CREATE INDEX "credential_events_created_at_idx" ON "credential_events" USING btree ("created_at");