-- Custom SQL migration file, put your code below! --

-- Spec: agent-payload-completeness
-- Adds dashboard-facing columns the Swift PayloadDecodeTests v2 now requires:
--
--   notifications.severity (info | warn | error)
--   notifications.delivery_state (pending | delivered | failed)
--   script_errors.trace_id (nullable, OTel trace id)
--   script_errors.stack_truncated (boolean, defaults false)
--
-- Defaults are non-null (except trace_id) so existing rows backfill cleanly.
-- The legacy `status` / `priority` columns on notifications are retained —
-- `status` still drives the dispatcher; severity / delivery_state are the
-- Swift-facing enums.

ALTER TABLE "notifications" ADD COLUMN "severity" text DEFAULT 'info' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "delivery_state" text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "script_errors" ADD COLUMN "trace_id" text;
--> statement-breakpoint
ALTER TABLE "script_errors" ADD COLUMN "stack_truncated" boolean DEFAULT false NOT NULL;