-- Custom SQL migration file, put your code below! --

-- Retire sessions stranded in 'active' state from before the hooks-event-persistence fix.
-- Idempotent: WHERE clause excludes already-ended rows on re-run.
UPDATE "sessions"
   SET "status" = 'ended',
       "ended_at" = "started_at" + INTERVAL '8 hours'
 WHERE "started_at" < TIMESTAMP '2026-04-24 00:00:00'
   AND "status" = 'active';
