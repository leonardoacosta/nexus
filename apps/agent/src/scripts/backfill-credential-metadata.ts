#!/usr/bin/env bun
/**
 * One-shot backfill: extract subscription metadata from encrypted credential
 * values and store them as plain columns on the credentials table.
 *
 * Reads: subscription_type, rate_limit_tier, expires_at from
 *        claudeAiOauth.{subscriptionType, rateLimitTier, expiresAt}
 *
 * Usage:
 *   POSTGRES_URL=... NEXUS_ENCRYPTION_KEY=... bun run apps/agent/src/scripts/backfill-credential-metadata.ts
 */

import { createDb } from "@nexus/db";
import { credentials } from "@nexus/db";
import { eq } from "drizzle-orm";
import { loadEncryptionKey, decrypt } from "../credentials/encryption";

interface OAuthBlob {
  claudeAiOauth?: {
    subscriptionType?: string;
    rateLimitTier?: string;
    expiresAt?: number;
  };
}

async function main() {
  const dbUrl = process.env.POSTGRES_URL;
  if (!dbUrl) {
    throw new Error("POSTGRES_URL is required.");
  }

  let encryptionKey: Buffer;
  try {
    encryptionKey = loadEncryptionKey();
  } catch (err) {
    console.error(
      `NEXUS_ENCRYPTION_KEY error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const { db, client } = createDb(dbUrl);

  const allRows = await db.select().from(credentials);
  console.log(`Found ${allRows.length} credentials to backfill.\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of allRows) {
    if (!row.valueEncrypted) {
      console.log(`  - ${row.name} (${row.id}) -- no encrypted value, skipping`);
      skipped++;
      continue;
    }

    try {
      const plaintext = decrypt(row.valueEncrypted, encryptionKey);
      const parsed: OAuthBlob = JSON.parse(plaintext);
      const oauth = parsed.claudeAiOauth;

      if (!oauth) {
        console.log(`  - ${row.name} (${row.id}) -- no claudeAiOauth object, skipping`);
        skipped++;
        continue;
      }

      const subscriptionType = oauth.subscriptionType ?? null;
      const rateLimitTier = oauth.rateLimitTier ?? null;
      const expiresAt =
        typeof oauth.expiresAt === "number"
          ? new Date(oauth.expiresAt)
          : null;

      if (!subscriptionType && !rateLimitTier && !expiresAt) {
        console.log(`  - ${row.name} (${row.id}) -- no metadata fields present, skipping`);
        skipped++;
        continue;
      }

      await db
        .update(credentials)
        .set({
          subscriptionType,
          rateLimitTier,
          expiresAt,
        })
        .where(eq(credentials.id, row.id));

      updated++;
      console.log(
        `  + ${row.name} -- sub=${subscriptionType ?? "null"}, tier=${rateLimitTier ?? "null"}, expires=${expiresAt?.toISOString() ?? "null"}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  x ${row.name} (${row.id}) -- ${msg}`);
      errors++;
    }
  }

  console.log(
    `\nDone: ${updated} updated, ${skipped} skipped, ${errors} errors (of ${allRows.length} total)`,
  );

  await client.end();

  if (errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
