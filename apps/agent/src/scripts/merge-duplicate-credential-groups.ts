#!/usr/bin/env bun
/**
 * One-shot repair: merge credential rows that share the same OAuth
 * refresh-token `fingerprint` but have drifted onto DIFFERENT
 * `duplicate_group_id` values (nx-9qsmb.2).
 *
 * Root cause (fixed alongside this script in
 * `apps/agent/src/credentials/pool/pool-core.ts`'s `add()`): `updateSecret()`
 * intentionally rotates a row's `fingerprint` in place while leaving its
 * `duplicate_group_id` untouched (the stable per-account anchor). If the
 * SAME rotated fingerprint is later re-observed under a different derived
 * `name` -- e.g. `active-credential-watcher.ts`'s `acct-<fp8>` fallback path
 * after an agent restart resets its in-memory rotation tracking -- `add()`'s
 * dedup guards both miss (the `(fingerprint, name)` re-import check, and the
 * `duplicate_group_id = fingerprint` group-lookup, since the existing row's
 * anchor is the OLD fingerprint) and a brand new row gets inserted for what
 * is actually the same account: two rows, same current fingerprint,
 * different duplicate_group_id.
 *
 * This script finds every such drifted group and collapses it to one row:
 *   - survivor = the row with the most recently polled usage data
 *     (`usage_polled_at` desc; falls back to `updated_at` desc, then `id`
 *     asc for determinism)
 *   - any NULL identity/metadata field on the survivor is backfilled from
 *     the most-recently-updated loser that has a non-null value
 *   - all rows in the group are realigned onto a single canonical
 *     `duplicate_group_id` (the shared fingerprint)
 *   - the survivor is marked `is_primary = true`, losers demoted
 *   - losers are deleted via `CredentialPool.deleteById()` (reuses the
 *     production delete path -- transactional, audit-logged) rather than a
 *     raw DELETE
 *
 * Safety:
 *   - Dry-run by default. Pass `--apply` to actually write.
 *   - A group where ANY member currently holds an active lease
 *     (`leased_by IS NOT NULL`) is reported but SKIPPED -- never
 *     auto-deletes a row a live session might still be holding.
 *   - A group whose members already share one `duplicate_group_id` is
 *     untouched -- that is the legitimate "same account, multiple pool
 *     files" case (see `pool-core-dedup.test.ts`), not the drift bug.
 *
 * Usage:
 *   POSTGRES_URL=... bun run apps/agent/src/scripts/merge-duplicate-credential-groups.ts          # dry-run
 *   POSTGRES_URL=... bun run apps/agent/src/scripts/merge-duplicate-credential-groups.ts --apply   # write
 */

import { createDb, credentials, scriptErrors } from "@nexus/db";
import { eq } from "drizzle-orm";
import {
  attachScriptErrorSink,
  createLogger,
  withErrorCapture,
} from "@nexus/core/node";
import { CredentialPool } from "../credentials/pool";

type CredentialRow = typeof credentials.$inferSelect;

/** Nullable-identity/metadata fields backfilled onto the survivor from a loser. */
const BACKFILL_FIELDS = [
  "accountEmail",
  "accountName",
  "accountUuid",
  "orgName",
  "orgUuid",
  "subscriptionType",
  "rateLimitTier",
  "mcpProviders",
  "expiresAt",
] as const satisfies readonly (keyof CredentialRow)[];

const log = createLogger("merge-duplicate-credential-groups");

/** Sort key for survivor selection: freshest usage poll wins, then updatedAt, then id. */
function survivorRank(row: CredentialRow): [number, number, string] {
  const usagePolled = row.usagePolledAt?.getTime() ?? -Infinity;
  const updated = row.updatedAt.getTime();
  return [usagePolled, updated, row.id];
}

function pickSurvivor(rows: CredentialRow[]): CredentialRow {
  return [...rows].sort((a, b) => {
    const [aUsage, aUpdated, aId] = survivorRank(a);
    const [bUsage, bUpdated, bId] = survivorRank(b);
    if (aUsage !== bUsage) return bUsage - aUsage;
    if (aUpdated !== bUpdated) return bUpdated - aUpdated;
    return aId.localeCompare(bId);
  })[0]!;
}

await withErrorCapture("merge-duplicate-credential-groups", async () => {
  const apply = process.argv.includes("--apply");
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

  const pool = new CredentialPool(db);

  const allRows = await db.select().from(credentials);
  log.info({ total: allRows.length, apply }, "duplicate-group merge scan started");

  const byFingerprint = new Map<string, CredentialRow[]>();
  for (const row of allRows) {
    if (!row.fingerprint) continue;
    const bucket = byFingerprint.get(row.fingerprint) ?? [];
    bucket.push(row);
    byFingerprint.set(row.fingerprint, bucket);
  }

  let groupsScanned = 0;
  let groupsDrifted = 0;
  let groupsSkippedLeased = 0;
  let groupsMerged = 0;
  let rowsDeleted = 0;

  for (const [fingerprint, rows] of byFingerprint) {
    if (rows.length < 2) continue;
    groupsScanned++;

    const distinctGroupIds = new Set(rows.map((r) => r.duplicateGroupId));
    if (distinctGroupIds.size <= 1) {
      // Already consistent -- legitimate multi-file duplicate group.
      continue;
    }

    groupsDrifted++;
    const fp8 = fingerprint.slice(0, 8);

    log.warn(
      {
        fingerprint: fp8,
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          duplicateGroupId: r.duplicateGroupId,
          isPrimary: r.isPrimary,
          status: r.status,
          leasedBy: r.leasedBy,
          usagePolledAt: r.usagePolledAt?.toISOString() ?? null,
          updatedAt: r.updatedAt.toISOString(),
        })),
      },
      "detected duplicate_group_id drift for a shared fingerprint",
    );

    const activelyLeased = rows.find((r) => r.leasedBy !== null);
    if (activelyLeased) {
      groupsSkippedLeased++;
      log.warn(
        { fingerprint: fp8, leasedRowId: activelyLeased.id, leasedBy: activelyLeased.leasedBy },
        "SKIPPING merge: a row in this drifted group is actively leased",
      );
      continue;
    }

    const survivor = pickSurvivor(rows);
    const losers = rows.filter((r) => r.id !== survivor.id);
    const canonicalGroupId = fingerprint;

    const backfill: Partial<Pick<CredentialRow, (typeof BACKFILL_FIELDS)[number]>> = {};
    const losersByRecency = [...losers].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
    for (const field of BACKFILL_FIELDS) {
      if (survivor[field] !== null && survivor[field] !== undefined) continue;
      for (const loser of losersByRecency) {
        const val = loser[field];
        if (val !== null && val !== undefined) {
          // Each field is read and written back as its own column type; the
          // cast is required because `field` is a union key, not a literal,
          // so TS can't narrow `val`'s type to match `backfill[field]`.
          (backfill as Record<string, unknown>)[field] = val;
          break;
        }
      }
    }

    log.info(
      {
        fingerprint: fp8,
        survivorId: survivor.id,
        survivorName: survivor.name,
        loserIds: losers.map((l) => l.id),
        canonicalGroupId: canonicalGroupId.slice(0, 8),
        backfillFields: Object.keys(backfill),
        apply,
      },
      apply ? "merging drifted group" : "DRY-RUN: would merge drifted group",
    );

    if (!apply) continue;

    await db.transaction(async (tx) => {
      for (const row of rows) {
        await tx
          .update(credentials)
          .set({ duplicateGroupId: canonicalGroupId })
          .where(eq(credentials.id, row.id));
      }
      await tx
        .update(credentials)
        .set({ isPrimary: true, ...backfill })
        .where(eq(credentials.id, survivor.id));
      for (const loser of losers) {
        await tx
          .update(credentials)
          .set({ isPrimary: false })
          .where(eq(credentials.id, loser.id));
      }
    });

    for (const loser of losers) {
      await pool.deleteById(loser.id);
      rowsDeleted++;
      log.info(
        { fingerprint: fp8, deletedId: loser.id, survivorId: survivor.id },
        "deleted merged duplicate row",
      );
    }

    groupsMerged++;
  }

  log.info(
    {
      groupsScanned,
      groupsDrifted,
      groupsSkippedLeased,
      groupsMerged,
      rowsDeleted,
      apply,
    },
    "duplicate-group merge scan complete",
  );

  await client.end();
});
