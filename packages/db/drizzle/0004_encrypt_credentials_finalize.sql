-- Custom SQL migration file, put your code below! --
-- Phase 2: finalize encryption migration.
-- Apply ONLY after scripts/encrypt-credentials.ts has confirmed zero
-- value_encrypted IS NULL rows remain.
ALTER TABLE "credentials" ALTER COLUMN "value_encrypted" SET NOT NULL;
ALTER TABLE "credentials" ALTER COLUMN "encryption_key_id" SET NOT NULL;
ALTER TABLE "credentials" DROP COLUMN "value_plaintext";