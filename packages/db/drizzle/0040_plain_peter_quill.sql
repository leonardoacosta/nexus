CREATE TABLE "presence_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"hold_until" timestamp NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"released_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "routing_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"priority" integer NOT NULL,
	"condition" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "presence_aware_routing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "unknown_noncritical_mode" text DEFAULT 'fail-safe' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "unknown_critical_mode" text DEFAULT 'fail-open' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "stop_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "error_details" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "agent_state" text;--> statement-breakpoint
CREATE INDEX "presence_holds_user_hold_until_idx" ON "presence_holds" USING btree ("user_id","hold_until");--> statement-breakpoint
CREATE INDEX "routing_rules_user_priority_idx" ON "routing_rules" USING btree ("user_id","priority");