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
 */

import { createDb } from "@nexus/db";
import { credentials } from "@nexus/db";
import { eq } from "drizzle-orm";
import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";

interface McpOAuthEntry {
  serverName?: string;
}

async function main() {
  const dbUrl = process.env.POSTGRES_URL;
  if (!dbUrl) {
    throw new Error("POSTGRES_URL is required.");
  }

  const { db, client } = createDb(dbUrl);

  // Discover credential files on disk
  const credDir = join(process.env.HOME ?? "", ".config/nexus/credentials");
  const allFiles = await readdir(credDir);
  const files = allFiles
    .filter((f) => f.startsWith("acct-") && f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    console.log("No acct-*.json files found. Nothing to backfill.");
    await client.end();
    return;
  }

  console.log(`Found ${files.length} credential files in ${credDir}\n`);

  // Load all DB rows for name matching
  const allRows = await db.select().from(credentials);
  const rowsByName = new Map(allRows.map((r) => [r.name, r]));

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
        console.log(`  - ${name} -- no mcpOAuth object, skipping`);
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
        console.log(`  - ${name} -- no MCP providers found, skipping`);
        skipped++;
        continue;
      }

      const mcpProviders = providers.join(",");

      // Find all DB rows matching this name (there may be duplicates)
      const matchingRows = allRows.filter((r) => r.name === name);

      if (matchingRows.length === 0) {
        console.log(`  ? ${name} -- no matching DB row, skipping`);
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
      console.log(
        `  + ${name} -- ${providers.join(", ")} (${matchingRows.length} row(s))`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  x ${name} -- ${msg}`);
    }
  }

  console.log(
    `\nDone: ${updated} rows updated, ${skipped} skipped, ${noMatch} no-match (of ${files.length} files)`,
  );

  await client.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
