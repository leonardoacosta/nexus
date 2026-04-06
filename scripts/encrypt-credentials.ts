/**
 * One-time idempotent migration script: encrypt all plaintext credentials.
 *
 * NOTE: This script is designed to run BEFORE the value_plaintext column is
 * dropped. It uses raw SQL to reference value_plaintext because the Drizzle
 * schema no longer includes that column (task 1.5 removed it).
 *
 * Selects every row where value_encrypted IS NULL and value_plaintext IS NOT NULL,
 * encrypts the plaintext value with AES-256-GCM, and writes value_encrypted +
 * encryption_key_id back to the row.
 *
 * Safe to re-run: rows that already have value_encrypted are skipped.
 *
 * Usage:
 *   POSTGRES_URL=... NEXUS_ENCRYPTION_KEY=<64-hex> bun scripts/encrypt-credentials.ts
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { credentials } from "../packages/db/src/schema/credentials";
import { loadEncryptionKey, encrypt } from "../apps/agent/src/credentials/encryption";

type MigrationRow = { id: string; name: string; value_plaintext: string };

async function main() {
  const pgUrl = process.env.POSTGRES_URL;
  if (!pgUrl) {
    console.error("POSTGRES_URL is required");
    process.exit(1);
  }

  let encryptionKey: Buffer;
  try {
    encryptionKey = loadEncryptionKey();
  } catch (err) {
    console.error("Encryption key error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: pgUrl });
  const db = drizzle(pool);

  // Select rows that need migration via raw SQL (value_plaintext is no longer in Drizzle schema)
  const rows = await db.execute<MigrationRow>(
    sql`SELECT id, name, value_plaintext FROM credentials WHERE value_encrypted IS NULL AND value_plaintext IS NOT NULL`,
  );

  console.log(`Found ${rows.length} row(s) to encrypt.`);

  let encrypted = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.value_plaintext) {
      skipped++;
      continue;
    }

    const valueEncrypted = encrypt(row.value_plaintext, encryptionKey);

    await db
      .update(credentials)
      .set({ valueEncrypted, encryptionKeyId: "v1" })
      .where(sql`${credentials.id} = ${row.id}`);

    encrypted++;
    console.log(`  ✓ Encrypted credential: ${row.id} (${row.name})`);
  }

  console.log(`\nDone. Encrypted: ${encrypted}, Skipped: ${skipped}`);

  // Verify: check for any remaining unencrypted rows
  const remaining = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(sql`${credentials.valueEncrypted} IS NULL`);

  if (remaining.length > 0) {
    console.error(
      `\nWARNING: ${remaining.length} row(s) still have value_encrypted IS NULL.`,
    );
    console.error("These rows may have had null value_plaintext — inspect manually.");
    process.exit(1);
  }

  console.log("Verification passed: all rows have value_encrypted set.");
  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
