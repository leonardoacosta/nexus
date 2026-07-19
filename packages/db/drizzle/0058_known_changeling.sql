ALTER TABLE "sessions" ADD COLUMN "git_dirty" boolean;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "git_ahead" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "git_behind" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "is_monitor_session" boolean;