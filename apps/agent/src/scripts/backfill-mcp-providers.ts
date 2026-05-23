#!/usr/bin/env bun
/**
 * One-shot backfill: extract MCP provider names from on-disk credential files
 * and store them in the mcp_providers column.
 *
 * Reads directly from ~/.config/nexus/credentials/acct-*.json (unencrypted),
 * matches each file to a DB row by name (acct-XXXXXXXX), and writes a
 * comma-separated list of provider names.
 *
 * Usage:
 *   POSTGRES_URL=... bun run apps/agent/src/scripts/backfill-mcp-providers.ts
 *
 * Migrated to createLogger + withErrorCapture per nx-gk6qw / enforce-pino-script-errors.
 */

import { createDb, credentials, scriptErrors } from "@nexus/db";
import { eq } from "drizzle-orm";
import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import {
  attachScriptErrorSink,
  createLogger,
  withErrorCapture,
} from "@nexus/core/node";

interface McpOAuthEntry {
  serverName?: string;
}

const log = createLogger("backfill-mcp-providers");

await withErrorCapture("backfill-mcp-providers", async () => {
  const dbUrl = process.env.POSTGRES_URL;
  if (!dbUrl) {
    throw new Error("POSTGRES_URL is required");
  }

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

  // Discover credential files on disk
  const credDir = join(process.env.HOME ?? "", ".config/nexus/credentials");
  const allFiles = await readdir(credDir);
  const files = allFiles
    .filter((f) => f.startsWith("acct-") && f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    log.info({ dir: credDir }, "no acct-*.json files found — nothing to backfill");
    await client.end();
    return;
  }

  log.info({ count: files.length, dir: credDir }, "discovered credential files");

  // Load all DB rows for name matching
  const allRows = await db.select().from(credentials);

  let updated = 0;
  let skipped = 0;
  let noMatch = 0;

  for (const file of files) {
    const name = basename(file, ".json"); // e.g., "acct-0752a674"
    const filePath = join(credDir, file);

    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      const mcpOAuth = parsed?.mcpOAuth;

      if (typeof mcpOAuth !== "object" || mcpOAuth === null) {
        log.info({ name }, "skip: no mcpOAuth object");
        skipped++;
        continue;
      }

      const providers = [
        ...new Set(
          Object.values(mcpOAuth as Record<string, McpOAuthEntry>)
            .map((v) => v?.serverName)
            .filter((n): n is string => typeof n === "string" && n.length > 0),
        ),
      ].sort();

      if (providers.length === 0) {
        log.info({ name }, "skip: no MCP providers found");
        skipped++;
        continue;
      }

      const mcpProviders = providers.join(",");

      // Find all DB rows matching this name (there may be duplicates)
      const matchingRows = allRows.filter((r) => r.name === name);

      if (matchingRows.length === 0) {
        log.warn({ name }, "no matching DB row — skipping");
        noMatch++;
        continue;
      }

      for (const row of matchingRows) {
        await db
          .update(credentials)
          .set({ mcpProviders })
          .where(eq(credentials.id, row.id));
      }

      updated += matchingRows.length;
      log.info(
        { name, providers, rowCount: matchingRows.length },
        "updated mcp_providers",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ name, error: msg }, "backfill failed for file");
    }
  }

  log.info(
    { updated, skipped, noMatch, total: files.length },
    "mcp-providers backfill complete",
  );

  await client.end();
});
