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
 *
 * Migrated to createLogger + withErrorCapture per nx-gk6qw / enforce-pino-script-errors.
 */

import { createDb, credentials, scriptErrors } from "@nexus/db";
import { eq } from "drizzle-orm";
import {
  attachScriptErrorSink,
  createLogger,
  withErrorCapture,
} from "@nexus/core/node";
import { loadEncryptionKey, decrypt } from "../credentials/encryption";

interface OAuthBlob {
  claudeAiOauth?: {
    subscriptionType?: string;
    rateLimitTier?: string;
    expiresAt?: number;
  };
}

const log = createLogger("backfill-credential-metadata");

await withErrorCapture("backfill-credential-metadata", async () => {
  const dbUrl = process.env.POSTGRES_URL;
  if (!dbUrl) {
    throw new Error("POSTGRES_URL is required");
  }

  const encryptionKey: Buffer = loadEncryptionKey();

  const { db, client } = createDb(dbUrl);
  attachScriptErrorSink({
    async insert(records) {
      await db.insert(scriptErrors).values(
        records.map((r) => ({
          id: r.id,
          scriptName: r.scriptName,
          level: r.level,
          message: r.message,
          stack: r.stack,
          context: r.context,
          machine: r.machine,
          exitCode: r.exitCode,
          createdAt: r.createdAt,
        })),
      );
    },
  });

  const allRows = await db.select().from(credentials);
  log.info({ total: allRows.length }, "credentials backfill started");

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of allRows) {
    if (!row.valueEncrypted) {
      log.info({ id: row.id, name: row.name }, "skip: no encrypted value");
      skipped++;
      continue;
    }

    try {
      const plaintext = decrypt(row.valueEncrypted, encryptionKey);
      const parsed: OAuthBlob = JSON.parse(plaintext);
      const oauth = parsed.claudeAiOauth;

      if (!oauth) {
        log.info(
          { id: row.id, name: row.name },
          "skip: no claudeAiOauth object",
        );
        skipped++;
        continue;
      }

      const subscriptionType = oauth.subscriptionType ?? null;
      const rateLimitTier = oauth.rateLimitTier ?? null;
      const expiresAt =
        typeof oauth.expiresAt === "number" ? new Date(oauth.expiresAt) : null;

      if (!subscriptionType && !rateLimitTier && !expiresAt) {
        log.info(
          { id: row.id, name: row.name },
          "skip: no metadata fields present",
        );
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
      log.info(
        {
          id: row.id,
          name: row.name,
          subscriptionType,
          rateLimitTier,
          expiresAt: expiresAt?.toISOString() ?? null,
        },
        "updated credential metadata",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ id: row.id, name: row.name, error: msg }, "backfill failed");
      errors++;
    }
  }

  log.info(
    { updated, skipped, errors, total: allRows.length },
    "credentials backfill complete",
  );

  await client.end();

  if (errors > 0) {
    throw new Error(`${errors} credential(s) failed to backfill`);
  }
});
