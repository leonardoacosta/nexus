-- Re-seed the notification_settings sentinel row (id = 1).
--
-- The original seed lives in 0022_cuddly_franklin_storm.sql. This migration is
-- a belt-and-suspenders safety net for environments where the sentinel row may
-- be missing — e.g. databases initialized via `drizzle-kit push` (which
-- bypasses migrations), partial restores, or hand-bootstrapped dev DBs. The
-- `ON CONFLICT DO NOTHING` clause keeps it a true no-op for the common case.
INSERT INTO "notification_settings" ("id", "tts_enabled", "banner_enabled", "ducking_mode", "updated_at")
VALUES (1, true, true, 'full', now())
ON CONFLICT ("id") DO NOTHING;