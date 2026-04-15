#!/usr/bin/env bun
/**
 * One-shot probe: call Anthropic's /api/oauth/profile for each credential
 * and backfill account_email, account_name, account_uuid, org_name, org_uuid.
 *
 * Usage:
 *   POSTGRES_URL=... NEXUS_ENCRYPTION_KEY=... bun run apps/agent/src/scripts/probe-credential-identity.ts
 */

import { createDb } from "@nexus/db";
import { credentials } from "@nexus/db";
import { eq } from "drizzle-orm";
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
  console.log(`Found ${allRows.length} credentials to probe.\n`);

  let probed = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of allRows) {
    if (!row.valueEncrypted) {
      console.log(`  - ${row.name} (${row.id}) -- no encrypted value, skipping`);
      skipped++;
      continue;
    }

    try {
      const plaintext = decrypt(row.valueEncrypted, encryptionKey);
      const parsed = JSON.parse(plaintext);
      const accessToken = parsed?.claudeAiOauth?.accessToken;

      if (!accessToken || typeof accessToken !== "string") {
        console.log(`  - ${row.name} -- no accessToken in OAuth blob, skipping`);
        skipped++;
        continue;
      }

      const res = await fetch(PROFILE_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(
          `  x ${row.name} -- HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 120)}` : ""}`,
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
      console.log(
        `  + ${row.name} -- ${accountEmail ?? "no-email"} | org=${orgName ?? "none"}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  x ${row.name} (${row.id}) -- ${msg}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  console.log(
    `\nDone: ${probed} probed, ${failed} failed, ${skipped} skipped (of ${allRows.length} total)`,
  );

  await client.end();

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
