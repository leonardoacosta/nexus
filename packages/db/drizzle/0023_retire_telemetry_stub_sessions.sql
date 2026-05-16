-- Custom SQL migration file, put your code below! --

-- One-shot cleanup for telemetry-stub session rows.
--
-- Stubs are rows synthesized by hook / notification telemetry pings on the
-- agent before fix-agent-cc-session-tracking landed: they carry no CC-real
-- discriminator (pid, tmux_target, cc_session_id, cwd are all NULL/empty) and
-- never received a corresponding end-of-life event, so they sit indefinitely
-- with ended_at = NULL.
--
-- Close them in a single sweep so the menu bar / dashboard stop counting
-- ghosts. Idempotent on re-run: the WHERE clause excludes any row already
-- closed or any row that has since acquired a real fingerprint.
UPDATE "sessions"
   SET "ended_at" = NOW(),
       "status"   = 'ended'
 WHERE "ended_at" IS NULL
   AND "pid" IS NULL
   AND ("tmux_target" IS NULL OR "tmux_target" = '')
   AND "cc_session_id" IS NULL
   AND ("cwd" IS NULL OR "cwd" = '');
