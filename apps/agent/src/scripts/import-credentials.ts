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
 *
 * Note: nx-wo9f9 made the agent's credential-watcher auto-import on startup,
 * so this script is now redundant for steady-state operation. Retained as a
 * one-shot recovery tool for cases where the DB is empty and a fresh agent
 * restart isn't acceptable.
 *
 * Migrated to createLogger + withErrorCapture per nx-gk6qw / enforce-pino-script-errors.
 */

import { createDb, scriptErrors } from "@nexus/db";
import {
  attachScriptErrorSink,
  createLogger,
  withErrorCapture,
} from "@nexus/core/node";
import { CredentialPool } from "../credentials/pool";
import { loadEncryptionKey } from "../credentials/encryption";
import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

const log = createLogger("import-credentials");

await withErrorCapture("import-credentials", async () => {
  // ── Validate environment ──────────────────────────────────────────────────
  const dbUrl = process.env.POSTGRES_URL;
  if (!dbUrl) {
    throw new Error("POSTGRES_URL is required");
  }

  const encryptionKey: Buffer = loadEncryptionKey();

  // ── Open database ─────────────────────────────────────────────────────────
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

  const pool = new CredentialPool(db, { encryptionKey });

  // ── Discover credential files ─────────────────────────────────────────────
  const credDir = join(process.env.HOME ?? "", ".config/nexus/credentials");
  let allFiles: string[];
  try {
    allFiles = await readdir(credDir);
  } catch (err) {
    await client.end();
    throw new Error(
      `Cannot read credential directory ${credDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const files = allFiles
    .filter((f) => f.startsWith("acct-") && f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    log.info({ dir: credDir }, "no acct-*.json files found — nothing to import");
    await client.end();
    return;
  }

  log.info({ count: files.length, dir: credDir }, "discovered credential files");

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
      log.info({ name }, "credential imported");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ name, error: msg }, "credential import failed");
      errors++;
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const allCreds = await pool.list();
  log.info(
    { imported, errors, total: files.length, poolSize: allCreds.length },
    "import complete",
  );

  await client.end();

  if (errors > 0) {
    throw new Error(`${errors} credential(s) failed to import`);
  }
});
