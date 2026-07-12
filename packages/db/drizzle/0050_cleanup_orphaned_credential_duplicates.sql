-- Data-only cleanup migration (nx-h5ur8): delete orphaned pre-dedup credential
-- duplicate rows.
--
-- Root cause (already fixed in code, commit cc540485, 2026-07-03):
-- CredentialPool.add() used to unconditionally INSERT a fresh row for every
-- credential file the watcher processed, instead of updating an existing
-- (fingerprint, name) match in place. Every OAuth token refresh / agent
-- restart between 2026-05-23 and 2026-07-03 appended another clone of the
-- same account, leaving ~2611 orphaned non-primary rows behind. The dedup fix
-- already stops new duplicates from being created (verified: zero duplicate
-- (fingerprint, name) groups created after 2026-07-03 23:00:35, live query
-- against production 2026-07-12). This migration is the one-time cleanup of
-- the pre-fix backlog.
--
-- Deletion predicate: a non-primary credential row whose duplicate_group_id
-- still has a live primary row. This is timestamp-independent and mirrors the
-- pool's own leaseability rule (CredentialPool.lease() only ever selects
-- is_primary = true rows) — a non-primary row with a primary sibling is by
-- definition inert: it can never be leased, and the account it represents is
-- already tracked by its primary.
--
-- Verified safe before writing this migration (production DB, 2026-07-12):
--   - 2611 rows match the predicate below.
--   - Every matched row has a sibling row in the same duplicate_group_id with
--     is_primary = true (zero rows would be left "orphaned" with no live
--     representative for their account).
--   - Zero rows are referenced by sessions.credential_id,
--     session_token_turns.credential_id, or credential_polls.credential_id
--     (credential_polls also carries an ON DELETE CASCADE FK to
--     credentials.id, so any future poll history for a deleted row would
--     cascade rather than orphan).
--   - All matched rows have status IN ('available', 'refresh_failed') and
--     account_email IS NULL/empty — dead pool clones, not live leased
--     credentials.
DELETE FROM "credentials" c
WHERE c."is_primary" = false
  AND EXISTS (
    SELECT 1 FROM "credentials" p
    WHERE p."duplicate_group_id" = c."duplicate_group_id"
      AND p."is_primary" = true
  );
