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

import { createDb, scriptErrors, sessions } from "@nexus/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import {
  attachScriptErrorSink,
  createLogger,
  withErrorCapture,
} from "@nexus/core/node";

import { resolveGitOrigin } from "../services/git-project";

const log = createLogger("backfill-git-origin");

await withErrorCapture("backfill-git-origin", async () => {
  const dbUrl = process.env.POSTGRES_URL;
  if (!dbUrl) {
    throw new Error("POSTGRES_URL is required");
  }

  const { db } = createDb(dbUrl);
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

  log.info({ scanned: rows.length, updated, skipped }, "backfill complete");
});
