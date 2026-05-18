#!/usr/bin/env bun
/**
 * One-shot backfill: resolve git_provider + git_owner_repo for every active
 * session row that doesn't already have them set.
 *
 * Skips rows where:
 *   - git_provider IS NOT NULL  (already backfilled)
 *   - cwd IS NULL OR ''         (not enough info to resolve)
 *   - ended_at IS NOT NULL      (closed sessions are not worth touching)
 *
 * Usage:
 *   POSTGRES_URL=... bun run apps/agent/src/scripts/backfill-git-origin.ts
 *
 * Spec: openspec/changes/add-git-project-resolver (task 1.5)
 */

import { createDb, sessions } from "@nexus/db";
import { and, eq, isNull, ne } from "drizzle-orm";

import { resolveGitOrigin } from "../services/git-project";

async function main(): Promise<void> {
  const dbUrl = process.env.POSTGRES_URL;
  if (!dbUrl) {
    console.error("POSTGRES_URL is required");
    process.exit(1);
  }

  const db = createDb(dbUrl);
  const rows = await db
    .select({
      id: sessions.id,
      cwd: sessions.cwd,
      endedAt: sessions.endedAt,
      gitProvider: sessions.gitProvider,
    })
    .from(sessions)
    .where(
      and(
        isNull(sessions.gitProvider),
        isNull(sessions.endedAt),
        ne(sessions.cwd, ""),
      ),
    );

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!row.cwd) {
      skipped++;
      continue;
    }
    const origin = await resolveGitOrigin(row.cwd);
    if (!origin) {
      skipped++;
      continue;
    }
    await db
      .update(sessions)
      .set({ gitProvider: origin.provider, gitOwnerRepo: origin.ownerRepo })
      .where(eq(sessions.id, row.id));
    updated++;
  }

  console.log(
    JSON.stringify({ scanned: rows.length, updated, skipped }, null, 2),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
