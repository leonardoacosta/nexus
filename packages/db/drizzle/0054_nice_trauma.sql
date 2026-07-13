ALTER TABLE "notification_settings" ADD COLUMN "rate_throttle_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "rate_throttle_max_per_window" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "rate_throttle_window_minutes" integer DEFAULT 5 NOT NULL;