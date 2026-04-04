CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT '',
	"host" text NOT NULL,
	"port" integer DEFAULT 7400,
	"projects_dir" text DEFAULT '',
	"enabled" boolean DEFAULT true,
	"last_seen" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"value_encrypted" text NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"leased_by" text,
	"leased_at" timestamp,
	"cooldown_until" timestamp
);
--> statement-breakpoint
CREATE TABLE "health_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "health_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"timestamp" timestamp NOT NULL,
	"cpu_percent" real,
	"ram_percent" real,
	"disk_percent" real,
	"docker_containers" integer,
	"raw_json" text
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"project" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp NOT NULL,
	"sent_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "session_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"session_id" text NOT NULL,
	"event_type" text NOT NULL,
	"timestamp" timestamp NOT NULL,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"machine" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp NOT NULL,
	"last_activity" timestamp NOT NULL,
	"ended_at" timestamp,
	"pid" integer,
	"cwd" text
);
--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;