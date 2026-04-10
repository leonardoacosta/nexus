-- sessions: replace legacy `project` text NOT NULL + drifted `project_id` text
-- with a proper uuid FK to projects.id. Table is empty so DROP+ADD is safe.
ALTER TABLE "sessions" DROP COLUMN "project";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- health_snapshots: add agent_id. Must be nullable first, backfill, then enforce NOT NULL.
ALTER TABLE "health_snapshots" ADD COLUMN "agent_id" text;--> statement-breakpoint
UPDATE "health_snapshots" SET "agent_id" = 'omarchy' WHERE "agent_id" IS NULL;--> statement-breakpoint
ALTER TABLE "health_snapshots" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "health_snapshots" ADD CONSTRAINT "health_snapshots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- credentials: nullable agent_id with SET NULL FK (no backfill needed).
ALTER TABLE "credentials" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- notifications: nullable agent_id with SET NULL FK (no backfill needed).
ALTER TABLE "notifications" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
