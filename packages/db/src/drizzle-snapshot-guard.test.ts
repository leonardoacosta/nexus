/**
 * fix-drizzle-snapshot-desync (task 2.1) — snapshot-regen regression guard.
 *
 * Locks the fix from task 1.1: the Drizzle meta snapshots
 * (`drizzle/meta/*_snapshot.json` + `_journal.json`) were reconciled with the
 * schema state produced by the custom-SQL migrations (0025/0027/0028/0029/
 * 0032 et al.) so a fresh `drizzle-kit generate` yields a CLEAN diff — no
 * spurious `CREATE TABLE` for tables those custom-SQL migrations already
 * created. Before the fix, the stale per-step snapshots lied about
 * schema-at-step and a regen re-emitted table creates.
 *
 * What this guard asserts
 * ───────────────────────
 *   1. `drizzle-kit generate` (the `db:generate` script) exits 0 and prints
 *      "No schema changes, nothing to migrate" — i.e. the live schema
 *      (src/schema) already matches the snapshot HEAD.
 *   2. The generate run creates NO new `NNNN_*.sql` migration file (a
 *      spurious regen would write one, re-emitting CREATE TABLE). If one
 *      appears, the guard deletes it (so the repo isn't dirtied) and FAILS.
 *   3. `drizzle-kit check` reports the snapshot/journal chain is consistent
 *      ("Everything's fine") — catches per-step snapshot desync that
 *      `generate` alone might not surface.
 *
 * Custom-SQL regen workflow (documented per task 2.1)
 * ───────────────────────────────────────────────────
 * This repo mixes drizzle-kit-generated migrations with HAND-WRITTEN custom
 * SQL (renames, data backfills, drops) that drizzle-kit cannot express. The
 * workflow for adding schema:
 *   1. Edit `src/schema/*` (the source of truth).
 *   2. Run `pnpm --filter @nexus/db db:generate` to emit the next
 *      `NNNN_*.sql` + bump `meta/_journal.json` and write the new
 *      `meta/NNNN_snapshot.json`.
 *   3. For custom SQL (rename/backfill/drop) that drizzle can't generate:
 *      write the `.sql` by hand, add a `_journal.json` entry, AND hand-write
 *      the matching `meta/NNNN_snapshot.json` reflecting the schema state
 *      AFTER that step (this is the step that historically drifted —
 *      fix-drizzle-snapshot-desync reconciled it).
 *   4. Re-run `db:generate` — it MUST say "No schema changes". This guard is
 *      the CI enforcement of that final invariant.
 *
 * Environment
 * ───────────
 * `drizzle.config.ts` throws if `POSTGRES_URL` is unset (read at config-load
 * time), but `generate`/`check` do NOT connect to the DB — they operate on the
 * local schema + snapshot files only. We provide a dummy URL when the env var
 * is absent so the guard runs offline / in CI without a live Postgres.
 */

import { describe, expect, it, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const drizzleDir = join(pkgRoot, "drizzle");
const drizzleKitBin = join(pkgRoot, "node_modules", ".bin", "drizzle-kit");

/** A POSTGRES_URL drizzle.config.ts requires at load time (no connection made). */
const ENV = {
  ...process.env,
  POSTGRES_URL:
    process.env.POSTGRES_URL ?? "postgres://guard:guard@localhost:5432/guard",
};

/** List the `NNNN_*.sql` migration files currently on disk. */
function listMigrationSql(): string[] {
  return readdirSync(drizzleDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
}

function runDrizzleKit(sub: "generate" | "check"): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(drizzleKitBin, [sub], {
    cwd: pkgRoot,
    env: ENV,
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe("drizzle snapshot regen guard (fix-drizzle-snapshot-desync task 2.1)", () => {
  beforeAll(() => {
    // Sanity: the drizzle-kit binary + drizzle dir must exist or the guard is
    // meaningless. Fail loudly rather than silently skip.
    expect(existsSync(drizzleKitBin)).toBe(true);
    expect(existsSync(drizzleDir)).toBe(true);
  });

  it("`drizzle-kit generate` emits NO spurious migration (No schema changes)", () => {
    const before = listMigrationSql();

    const { status, stdout, stderr } = runDrizzleKit("generate");
    const out = `${stdout}\n${stderr}`;

    const after = listMigrationSql();
    const newFiles = after.filter((f) => !before.includes(f));

    // Clean up any spuriously-generated migration BEFORE asserting, so a
    // failure never leaves the repo dirty for the next run / commit.
    for (const f of newFiles) {
      try {
        rmSync(join(drizzleDir, f), { force: true });
      } catch {
        // best-effort cleanup
      }
    }

    // The core regression assertion: a regen against a reconciled snapshot
    // MUST NOT write a new migration (which would carry CREATE TABLE for
    // already-migrated tables).
    expect(newFiles).toEqual([]);

    // drizzle-kit generate succeeds and reports a clean diff.
    expect(status).toBe(0);
    expect(out).toContain("No schema changes");
  });

  it("`drizzle-kit check` reports a consistent snapshot/journal chain", () => {
    const { status, stdout, stderr } = runDrizzleKit("check");
    const out = `${stdout}\n${stderr}`;

    // `check` validates the per-step snapshot + journal id/prevId chain — the
    // exact integrity that desynced before fix-drizzle-snapshot-desync.
    expect(status).toBe(0);
    expect(out).toContain("Everything's fine");
  });
});
