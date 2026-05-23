CREATE TABLE "process_watcher_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	"live_pid_count" integer NOT NULL,
	"tick_duration_ms" integer NOT NULL,
	"error_text" text
);
