#!/usr/bin/env bun
/**
 * One-shot credential import script.
 *
 * Reads acct-*.json files from ~/.config/nexus/credentials/ and inserts them
 * into the credentials table via CredentialPool.add(), which handles fingerprint
 * computation, duplicate group assignment, primary selection, and encryption.
 *
 * Usage:
 *   POSTGRES_URL=... NEXUS_ENCRYPTION_KEY=... bun run apps/agent/src/scripts/import-credentials.ts
 */

import { createDb } from "@nexus/db";
import { CredentialPool } from "../credentials/pool";
import { loadEncryptionKey } from "../credentials/encryption";
import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

async function main() {
  // ── Validate environment ──────────────────────────────────────────────────
  const dbUrl = process.env.POSTGRES_URL;
  if (!dbUrl) {
    throw new Error("POSTGRES_URL is required. Set it in the environment.");
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

  // ── Open database ─────────────────────────────────────────────────────────
  const { db, client } = createDb(dbUrl);
  const pool = new CredentialPool(db, { encryptionKey });

  // ── Discover credential files ─────────────────────────────────────────────
  const credDir = join(process.env.HOME ?? "", ".config/nexus/credentials");
  let allFiles: string[];
  try {
    allFiles = await readdir(credDir);
  } catch (err) {
    console.error(`Cannot read credential directory ${credDir}: ${err instanceof Error ? err.message : String(err)}`);
    await client.end();
    process.exit(1);
  }

  const files = allFiles
    .filter((f) => f.startsWith("acct-") && f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    console.log("No acct-*.json files found. Nothing to import.");
    await client.end();
    return;
  }

  console.log(`Found ${files.length} credential files in ${credDir}\n`);

  // ── Import each file ──────────────────────────────────────────────────────
  let imported = 0;
  let errors = 0;

  for (const file of files) {
    const filePath = join(credDir, file);
    const name = basename(file, ".json"); // e.g., "acct-0752a674"

    try {
      const plaintext = await readFile(filePath, "utf-8");

      // Sanity check: ensure it parses as JSON before sending to the pool
      JSON.parse(plaintext);

      await pool.add({
        id: randomUUID(),
        name,
        type: "oauth",
        value_plaintext: plaintext,
      });

      imported++;
      console.log(`  + ${name} -- imported`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  x ${name} -- ${msg}`);
      errors++;
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const allCreds = await pool.list();
  console.log(
    `\nDone: ${imported} imported, ${errors} errors (of ${files.length} files)`,
  );
  console.log(`DB now has ${allCreds.length} credential rows`);

  await client.end();

  if (errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
