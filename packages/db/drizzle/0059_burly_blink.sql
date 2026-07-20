ALTER TABLE "notification_settings" ADD COLUMN "signal_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "meeting_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "suppression_minutes" integer DEFAULT 0 NOT NULL;