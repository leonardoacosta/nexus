CREATE TABLE "notification_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"tts_enabled" boolean DEFAULT true NOT NULL,
	"banner_enabled" boolean DEFAULT true NOT NULL,
	"ducking_mode" text DEFAULT 'full' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "notification_settings" ("id", "tts_enabled", "banner_enabled", "ducking_mode") VALUES (1, true, true, 'full') ON CONFLICT ("id") DO NOTHING;
