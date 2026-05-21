-- Spec: adopt-reaper-into-nx-cron
--
-- Adds the two telemetry tables that back the in-process `reaper` cron job
-- ported from the chezmoi `weekly-cleanup` script (`if@8c49609`):
--
--   cron_runs   — one row per nx-cron job run (success / failure / aborted)
--   bloat_radar — one row per over-threshold disk finding emitted by the
--                 reaper's `bloat_radar()` scan. A clear run writes zero rows.
--
-- Both tables follow the `health_snapshots` shape (identity PK, `timestamp`
-- index) so the dashboard's existing trend-query patterns apply unchanged.
--
-- Note on migration trim: drizzle-kit generated additional CREATE TABLE
-- statements for tables (`cc_profiles`, `cc_profile_events`, `script_errors`,
-- `hook_schema_fingerprints`) and ALTER TABLE statements (`notifications`,
-- `sessions`) whose live state was previously introduced via custom SQL
-- migrations (0025, 0027, 0028, 0029, 0032) without being folded into the
-- Drizzle snapshot tree. Re-emitting those statements here would fail on
-- the live DB with "relation already exists". They are intentionally trimmed
-- from this file; the snapshot has been refreshed by drizzle-kit so future
-- migrations will diff against an accurate baseline.

CREATE TABLE "cron_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cron_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"timestamp" timestamp NOT NULL,
	"job" text NOT NULL,
	"status" text NOT NULL,
	"details" jsonb,
	"metrics" jsonb
);
--> statement-breakpoint
CREATE TABLE "bloat_radar" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bloat_radar_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"run_timestamp" timestamp NOT NULL,
	"label" text NOT NULL,
	"path" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"threshold_bytes" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cron_runs_timestamp_idx" ON "cron_runs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "bloat_radar_run_timestamp_idx" ON "bloat_radar" USING btree ("run_timestamp");
