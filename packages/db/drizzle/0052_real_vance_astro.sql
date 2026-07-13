CREATE TABLE "project_status_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "project_status_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"project" text NOT NULL,
	"proposals_unarchived" integer NOT NULL,
	"beads_ready_unlinked" integer NOT NULL,
	"beads_blocked_unlinked" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spec_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "spec_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"project" text NOT NULL,
	"spec_name" text NOT NULL,
	"completed" integer NOT NULL,
	"total" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "project_status_snapshots_project_idx" ON "project_status_snapshots" USING btree ("project");--> statement-breakpoint
CREATE INDEX "project_status_snapshots_created_at_idx" ON "project_status_snapshots" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "spec_snapshots_spec_idx" ON "spec_snapshots" USING btree ("project","spec_name");--> statement-breakpoint
CREATE INDEX "spec_snapshots_created_at_idx" ON "spec_snapshots" USING btree ("created_at");