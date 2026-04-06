CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"primary_agent_id" text NOT NULL,
	"description" text,
	"tags" text[],
	"status" text DEFAULT 'active' NOT NULL,
	"discovered_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "projects_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "project_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"path" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"active_sessions" integer DEFAULT 0 NOT NULL,
	"total_sessions" integer DEFAULT 0 NOT NULL,
	"last_discovered_at" timestamp,
	"priority" integer DEFAULT 999 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "project_locations_project_agent_unique" UNIQUE("project_id","agent_id")
);
