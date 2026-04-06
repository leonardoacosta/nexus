ALTER TABLE "sessions" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "session_type" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "rate_limit_utilization" real;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "total_cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "rate_limit_reset_at" timestamp;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "idle_since" timestamp;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cc_session_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "tmux_session" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "tmux_target" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "spec" text;