-- No-op: value_plaintext was already dropped in 0004_encrypt_credentials_finalize.sql.
-- This migration originally re-generated a redundant DROP COLUMN due to stale snapshot
-- tracking (0004/0005/0006 snapshots weren't updated after the hand-authored drop) —
-- see nx-ny1p2. Left as a no-op rather than deleted/renumbered because it is already
-- recorded as applied in every existing environment's __drizzle_migrations table.
ALTER TABLE "credentials" DROP COLUMN IF EXISTS "value_plaintext";
