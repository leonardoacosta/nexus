/**
 * Status-snapshot tick hook for the spec-watcher poll loop.
 *
 * Persists change-only status snapshots (per-spec completion +
 * proposals_unarchived) for one project's tick. Runs on every tick —
 * including firstTick — because the writer compares against the latest
 * persisted row, so a restart re-tick is a no-op when nothing changed.
 * Fire-and-forget so a DB hiccup never aborts the poll loop or blocks
 * transition emits. A no-op when no Db is wired (tests / legacy callers).
 */

import type { Db } from "@nexus/db";
import { recordSpecTickSnapshots } from "../status-snapshots";
import { safeFireAndForget } from "../../utils/safe-fire-and-forget";
import type { SpecSnapshot } from "./parser";

/**
 * Fire the change-only status-snapshot write for one project's tick.
 * No-op when `db` is undefined.
 */
export function recordTickSnapshot(
  db: Db | undefined,
  projectCode: string,
  specs: SpecSnapshot[],
): void {
  if (!db) return;
  safeFireAndForget(
    recordSpecTickSnapshots(db, projectCode, specs),
    "spec-tick-snapshots",
  );
}
