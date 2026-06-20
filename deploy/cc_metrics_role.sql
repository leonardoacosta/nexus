-- cc_metrics least-privilege Postgres role for the workflow-metrics
-- system-of-record (add-metrics-system-of-record Phase 1).
--
-- This is NOT a Drizzle migration. Postgres roles/grants are out of band of
-- `db:migrate`, so this file lives in deploy/ (next to POSTGRES_SCHEMA_MAP.md),
-- NOT in packages/db/drizzle/ (where it would be replayed by db:migrate and
-- corrupt the journal). The orchestrator applies it MANUALLY at gated deploy
-- time, AFTER migration 0045_nasty_baron_zemo.sql has created the three tables.
--
-- Run against the `nexus` database as the superuser (`cortex` owner role).
-- Replace <placeholder> with the real secret first. Distribute the secret to
-- cc producers as NEXUS_DB_URL via the workspace env / chezmoi (the same channel
-- nx's .env uses on the Mac) — NEVER the superuser `cortex` URL.
--
-- Apply (gated, by orchestrator):
--   psql "postgres://cortex:cortexdev@100.73.182.4:5436/nexus" -f deploy/cc_metrics_role.sql
-- or from homelab:
--   docker exec -i homelab-postgres psql -U cortex -d nexus < deploy/cc_metrics_role.sql

-- 1. Create the login role (idempotent guard).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cc_metrics') THEN
    CREATE ROLE cc_metrics LOGIN PASSWORD '<placeholder>';
  END IF;
END
$$;

-- 2. Allow connecting to the nexus database.
GRANT CONNECT ON DATABASE nexus TO cc_metrics;

-- 3. Schema usage (Nexus tables live in the default `public` schema).
GRANT USAGE ON SCHEMA public TO cc_metrics;

-- 4. Table-scoped DML — exactly the three metrics tables, nothing else.
GRANT SELECT, INSERT, UPDATE ON
  improvement_ledger,
  workflow_run,
  cc_decision
TO cc_metrics;

-- 5. Sequence usage — none of the three tables use serial/identity (all use
--    text/timestamp PKs), so no sequence grant is strictly required today.
--    Included defensively scoped to public in case a future additive column
--    adds one. Safe no-op if there are no sequences.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cc_metrics;

-- Intentionally NOT granted: DELETE, TRUNCATE, DDL, and access to any other
-- nexus table. cc producers can only append/update the metrics records.
