#!/usr/bin/env bun
/**
 * One-shot probe: call Anthropic's /api/oauth/profile for each credential
 * and backfill account_email, account_name, account_uuid, org_name, org_uuid.
 *
 * Usage:
 *   POSTGRES_URL=... NEXUS_ENCRYPTION_KEY=... bun run apps/agent/src/scripts/probe-credential-identity.ts
 *
 * Note: nx-44mby made the active-credential-watcher mirror live rotations
 * into the pool; the inline pool.add() auto-probe writes identity fields
 * on every rotation. This script remains useful for backfilling rows that
 * predate that change.
 *
 * Migrated to createLogger + withErrorCapture per nx-gk6qw / enforce-pino-script-errors.
 */

import { createDb, credentials, scriptErrors } from "@nexus/db";
import { eq } from "drizzle-orm";
import { fetchWithTimeout } from "@nexus/core/fetch";
import {
  attachScriptErrorSink,
  createLogger,
  withErrorCapture,
} from "@nexus/core/node";
import { loadEncryptionKey, decrypt } from "../credentials/encryption";

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const DELAY_MS = 200;

interface ProfileResponse {
  account?: {
    uuid?: string;
    full_name?: string;
    email?: string;
  };
  organization?: {
    uuid?: string;
    name?: string;
    organization_type?: string;
    rate_limit_tier?: string;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const log = createLogger("probe-credential-identity");

await withErrorCapture("probe-credential-identity", async () => {
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
  log.info({ total: allRows.length }, "identity probe started");

  let probed = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of allRows) {
    if (!row.valueEncrypted) {
      log.info({ id: row.id, name: row.name }, "skip: no encrypted value");
      skipped++;
      continue;
    }

    try {
      const plaintext = decrypt(row.valueEncrypted, encryptionKey);
      const parsed = JSON.parse(plaintext);
      const accessToken = parsed?.claudeAiOauth?.accessToken;

      if (!accessToken || typeof accessToken !== "string") {
        log.info(
          { name: row.name },
          "skip: no accessToken in OAuth blob",
        );
        skipped++;
        continue;
      }

      const res = await fetchWithTimeout(PROFILE_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 5_000,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.error(
          {
            name: row.name,
            status: res.status,
            statusText: res.statusText,
            body: body ? body.slice(0, 120) : null,
          },
          "identity probe returned non-2xx",
        );
        failed++;
        await sleep(DELAY_MS);
        continue;
      }

      const profile = (await res.json()) as ProfileResponse;
      const account = profile.account;
      const org = profile.organization;

      const accountEmail = account?.email ?? null;
      const accountName = account?.full_name ?? null;
      const accountUuid = account?.uuid ?? null;
      const orgName = org?.name ?? null;
      const orgUuid = org?.uuid ?? null;

      await db
        .update(credentials)
        .set({
          accountEmail,
          accountName,
          accountUuid,
          orgName,
          orgUuid,
        })
        .where(eq(credentials.id, row.id));

      probed++;
      log.info(
        {
          name: row.name,
          accountEmail,
          orgName,
        },
        "identity probed + persisted",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ id: row.id, name: row.name, error: msg }, "probe failed");
      failed++;
    }

    await sleep(DELAY_MS);
  }

  log.info(
    { probed, failed, skipped, total: allRows.length },
    "identity probe complete",
  );

  await client.end();

  if (failed > 0) {
    throw new Error(`${failed} credential(s) failed identity probe`);
  }
});
