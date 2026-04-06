# Operator Runbook: Credential Encryption Migration

Covers one-time migration of plaintext credentials to AES-256-GCM encrypted storage
and the subsequent column drop.

## Prerequisites

- PostgreSQL database running and accessible via `POSTGRES_URL`
- `pnpm db:push` already applied (schema includes `value_encrypted` + `encryption_key_id`)
- Node.js / Bun runtime available

---

## Step 1: Generate encryption key

Generate a random 32-byte key and store it securely:

```bash
openssl rand -hex 32
# Example output: a3f1... (64 hex chars)
```

Store the key in your secrets manager (e.g., Doppler, 1Password, Vault) under the name
`NEXUS_ENCRYPTION_KEY`. All agent instances must use the **same** key.

Export for the steps below:

```bash
export NEXUS_ENCRYPTION_KEY=<64-char-hex>
```

---

## Step 2: Run the encryption migration script

The script is idempotent — it skips rows that already have `value_encrypted` set.

```bash
POSTGRES_URL=postgresql://user:pass@host/nexus \
NEXUS_ENCRYPTION_KEY=$NEXUS_ENCRYPTION_KEY \
  bun scripts/encrypt-credentials.ts
```

Expected output:
```
Found N row(s) to encrypt.
  ✓ Encrypted credential: <id> (<name>)
  ...
Done. Encrypted: N, Skipped: 0
Verification passed: all rows have value_encrypted set.
```

If the script exits with an error, inspect the listed rows manually before proceeding.

---

## Step 3: Verify zero plaintext rows remain

```bash
psql $POSTGRES_URL -c \
  "SELECT COUNT(*) FROM credentials WHERE value_encrypted IS NULL;"
# Expected: 0
```

If the count is non-zero, re-run Step 2 after investigating the affected rows.

---

## Step 4: Apply the finalize migration (NOT NULL + column drop)

The migration at `packages/db/drizzle/0004_encrypt_credentials_finalize.sql` makes
`value_encrypted` NOT NULL and drops `value_plaintext`. It also matches what
`0007_aberrant_silver_fox.sql` does via the updated Drizzle schema.

Run via drizzle-kit:

```bash
cd packages/db
POSTGRES_URL=$POSTGRES_URL pnpm db:push
```

Or apply the SQL directly:

```sql
ALTER TABLE "credentials" ALTER COLUMN "value_encrypted" SET NOT NULL;
ALTER TABLE "credentials" ALTER COLUMN "encryption_key_id" SET NOT NULL;
ALTER TABLE "credentials" DROP COLUMN "value_plaintext";
```

---

## Step 5: Restart agent instances

All `nexus-agent` processes must be restarted with `NEXUS_ENCRYPTION_KEY` set in their
environment. The agent will fail fast at startup if the key is absent or malformed.

```bash
# systemd example
sudo systemctl restart nexus-agent

# or set in /etc/nexus/env and restart
```

---

## Step 6: Verify health

```bash
# Check agent startup log — should NOT contain "NEXUS_ENCRYPTION_KEY is not set"
journalctl -u nexus-agent --since "1 minute ago" | grep -i "encryption"

# Spot-check credential health endpoint
curl -s https://localhost:7400/credentials/<id>/health
# Expected: {"healthy":true,"checked_at":"..."}
```

---

## Rollback

If the migration must be reversed before the column drop:

1. Stop all agents
2. Restore a database backup taken before Step 2
3. Remove `NEXUS_ENCRYPTION_KEY` from agent environment
4. Restart agents

After the column has been dropped, rollback requires a full database restore.

---

## Key Rotation (future)

Key rotation is tracked in `openspec/changes/encrypt-credential-storage/` and is not
yet implemented. When needed:

1. Generate a new key (Step 1 above)
2. Decrypt all rows with the old key and re-encrypt with the new key
3. Update `NEXUS_ENCRYPTION_KEY` and `encryption_key_id` on affected rows
4. Restart agents
