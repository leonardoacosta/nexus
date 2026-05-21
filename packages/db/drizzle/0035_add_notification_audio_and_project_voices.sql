CREATE TABLE "project_voice_overrides" (
	"project" text PRIMARY KEY NOT NULL,
	"voice_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "audio_path" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "voice_used" text;