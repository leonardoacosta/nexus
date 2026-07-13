ALTER TABLE "notification_settings" ADD COLUMN "quiet_hours_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "quiet_hours_start_hour" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "quiet_hours_end_hour" integer DEFAULT 7 NOT NULL;