CREATE TABLE "git_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "git_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"project" text NOT NULL,
	"event_type" text NOT NULL,
	"from_ref" text,
	"to_ref" text,
	"sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "git_events_project_created_at_idx" ON "git_events" USING btree ("project","created_at");--> statement-breakpoint
CREATE INDEX "git_events_created_at_idx" ON "git_events" USING btree ("created_at");