/**
 * Active-credential watcher.
 *
 * Watches `~/.claude/.credentials.json` (the live credential file Claude Code
 * maintains, refreshes, and rotates) and:
 *   1. publishes the SHA-256 refresh-token fingerprint of the currently-active
 *      credential so the dashboard can mark exactly one account as "active";
 *   2. MIRRORS the live credential into the pool on every observation
 *      (bd:nx-44mby, widened by the fix below).
 *
 * Behaviour:
 *   - Resolves the path via `fs.realpath()` on every change (follows symlinks).
 *   - Debounces watch events (200ms) — rotations can cause multiple fs events.
 *   - Computes the fingerprint via `computeCredentialFingerprint()` on every
 *     observation. Claude Code performs FULL refresh-token rotation on (at
 *     least some) OAuth grants — each grant can return a new `refreshToken`
 *     alongside the new `accessToken` — so `fingerprint = SHA256(refreshToken)`
 *     is NOT a stable identity across time for the live file; see
 *     `pool-core.ts`'s `updateSecret()` doc, which exists for exactly this
 *     reason.
 *   - When the newly observed fingerprint differs from the PREVIOUSLY
 *     observed one (a rotation happened) AND the old fingerprint still has a
 *     matching pool row, calls `pool.updateSecret(oldRow.id, ...)` to update
 *     that row's token material IN PLACE. This is the fix for nx-lp8v/nx-m5q6
 *     (`credentials` table growing unbounded): the prior implementation
 *     called `pool.add()` unconditionally with a fingerprint-derived name
 *     (`acct-<fp8>`), so every rotation minted a BRAND NEW `isPrimary=true`
 *     row under the new fingerprint (a new `duplicateGroupId`, since that
 *     column is set to `fingerprint` itself on insert) and permanently
 *     orphaned the previous row — nothing ever demoted or cleaned it up.
 *     With real accounts rotating multiple times a day, this is what grew
 *     the table to thousands of rows with only one ever `isActive`.
 *   - Falls back to `pool.add()` (unconditional, idempotent — a
 *     `(fingerprint, name)` match updates in place, a miss inserts) when
 *     there is no previous fingerprint to compare against (cold start) or
 *     the previous fingerprint's row can no longer be found (e.g. deleted
 *     out from under the watcher). The auto-probe inside `pool.add()` hits
 *     api.anthropic.com (a different, un-throttled endpoint from the OAuth
 *     refresh-grant below) with the fresh access token and populates
 *     accountEmail/Name/Uuid/orgName/orgUuid for a newly inserted row.
 *   - All failure modes — file missing, JSON parse error, no `refreshToken`,
 *     pool.add() exception — collapse to `fingerprint: null` without throwing,
 *     so the watcher never crashes the agent.
 *
 * The watcher runs in parallel with `startCredentialWatcher()`, which watches
 * the credential *pool* directory at `~/.config/nexus/credentials/`. The pool
 * directory contains snapshots that quickly go stale because Claude Code
 * rotates refresh tokens; this watcher is the one that keeps the pool in
 * sync with Claude Code's live rotation cadence.
 *
 * Freshness contract (nx-6uzqi): watches the PARENT DIRECTORY (not the file
 * itself) so an in-place edit, a create, or a rename-into-place all have a
 * chance to trigger a refresh, mirroring the same directory-watch convention
 * `startCredentialWatcher()` already uses for the pool directory. That alone
 * is NOT sufficient, though: empirically verified against this repo's actual
 * Bun runtime, a rename-over-an-existing-file (the pattern most safe-write
 * implementations use to replace a file atomically) fires ZERO fs.watch
 * events under Bun 1.3.11, whether watching the file or its directory — a
 * real gap in Bun's fs.watch, not a hypothesis. If Claude Code's account
 * switch writes `.credentials.json` this way, watch-only leaves the
 * snapshot stuck on the pre-switch account indefinitely (the reported
 * symptom), same as the pre-fix single-file watch. The fix is defense in
 * depth: a periodic poll (`POLL_INTERVAL_MS`, matching the 60s cadence
 * `pool-core.ts`'s `startCleanup()` already uses for background
 * maintenance in this same module family) unconditionally re-reads the
 * live file on a fixed cadence regardless of whether any fs.watch event
 * fired, bounding worst-case staleness to one poll interval instead of
 * "until the agent restarts."
 */

import { watch, readFile, realpath, stat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLogger } from "@nexus/core/node";
import {
  computeCredentialFingerprint,
  extractCredentialMetadata,
  CredentialParseError,
} from "./credentials.helpers";
import type { CredentialPool } from "./pool";

/**
 * Minimal pool surface the watcher consumes. Tests inject a fake satisfying
 * just `list()`, `add()`, and `updateSecret()` — no DB or encryption setup
 * required.
 */
type WatcherPool = {
  list: () => Promise<Array<{ id: string; fingerprint: string | null }>>;
  add: (input: {
    id: string;
    name: string;
    type: string;
    value_plaintext: string;
  }) => Promise<"inserted" | "updated">;
  updateSecret: (
    id: string,
    newPlaintextBlob: object,
    newExpiresAt: Date,
  ) => Promise<void>;
};

const log = createLogger("agent:active-credential-watcher");

const DEBOUNCE_MS = 200;
/** Poll-fallback cadence -- mirrors pool-core.ts's `startCleanup()` default. */
const POLL_INTERVAL_MS = 60_000;
const CC_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");

/**
 * In-memory snapshot of the currently-active credential.
 *
 * Holds nulls until the first successful read. Updated atomically on every
 * debounced event.
 */
export interface ActiveCredentialSnapshot {
  /** Pool-matched fingerprint, or null. */
  fingerprint: string | null;
  /** Absolute realpath of the watched file, or null if resolution failed. */
  resolvedPath: string | null;
  /** ISO-8601 timestamp of the most recent observation. */
  observedAt: string;
}

const snapshot: ActiveCredentialSnapshot = {
  fingerprint: null,
  resolvedPath: null,
  observedAt: new Date(0).toISOString(),
};

/** Read the current snapshot (shared mutable state). */
export function getActiveCredentialSnapshot(): ActiveCredentialSnapshot {
  // Return a shallow copy so callers can't mutate our internal state.
  return { ...snapshot };
}

/**
 * Read the live credential file, resolve its real path, compute the
 * refresh-token fingerprint, and return the parsed plaintext alongside.
 * Returns `null` for every failure mode (file missing, parse error,
 * malformed OAuth blob).
 *
 * Extracted from the legacy `readActiveFingerprint` so the rotation-import
 * path in `runRefresh` can reuse the plaintext for `pool.add()` without a
 * second disk read.
 */
async function readActiveCredentialBlob(
  credentialPath: string,
): Promise<{
  plaintext: string;
  fingerprint: string;
  resolvedPath: string;
} | null> {
  let resolvedPath: string | null = null;
  try {
    resolvedPath = await realpath(credentialPath);
  } catch (err) {
    // Fall back to reading the original path — realpath fails if the link
    // target is missing, but the file itself (if not a symlink) may still
    // be readable.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      resolvedPath = credentialPath;
    } else {
      log.debug({ path: credentialPath }, "active credential file missing");
      return null;
    }
  }

  const finalPath = resolvedPath ?? credentialPath;

  let plaintext: string;
  try {
    plaintext = await readFile(finalPath, "utf-8");
  } catch (err) {
    log.debug(
      { path: finalPath, error: (err as Error).message },
      "failed to read active credential file",
    );
    return null;
  }

  let fingerprint: string;
  try {
    fingerprint = computeCredentialFingerprint(plaintext);
  } catch (err) {
    if (err instanceof CredentialParseError) {
      log.debug(
        { path: finalPath, error: err.message },
        "active credential file is not a valid OAuth blob",
      );
      return null;
    }
    throw err;
  }

  return { plaintext, fingerprint, resolvedPath: finalPath };
}

/**
 * Core refresh logic: read the live file, mirror into the pool on rotation,
 * and update the shared snapshot. Exposed via `__testing.runRefresh` so the
 * import-on-rotation contract can be exercised without spinning up
 * fs.watch / Postgres / encryption.
 *
 * `credentialPath` defaults to `~/.claude/.credentials.json` in production;
 * tests pass an in-tmpdir path.
 */
async function runRefresh(
  pool: WatcherPool,
  credentialPath: string = CC_CREDENTIALS_PATH,
): Promise<void> {
  const blob = await readActiveCredentialBlob(credentialPath);

  // Capture the PREVIOUSLY observed fingerprint before it gets overwritten
  // below — this is what lets us recognize a rotation (new fingerprint,
  // same underlying live session) instead of treating every rotation as a
  // brand-new credential.
  const previousFingerprint = snapshot.fingerprint;

  // Stamp the snapshot first so callers see a fresh observedAt even on
  // failure paths. fingerprint/resolvedPath default to null and are
  // overwritten below when the live file is readable.
  snapshot.observedAt = new Date().toISOString();

  if (!blob) {
    snapshot.fingerprint = null;
    snapshot.resolvedPath = null;
    return;
  }

  const { plaintext, fingerprint, resolvedPath } = blob;
  snapshot.resolvedPath = resolvedPath;

  // Fetch the pool listing once: it doubles as a down-detection check
  // (confirm the pool is reachable before writing to it) and, on a
  // rotation, as the lookup for the row to update in place.
  let poolRows: Array<{ id: string; fingerprint: string | null }>;
  try {
    poolRows = await pool.list();
  } catch (err) {
    // Pool read failed — surface the LIVE fingerprint anyway so the UI can
    // distinguish "Claude Code is up" from "Claude Code is down". Cannot
    // safely write; snapshot retains the unmatched live fingerprint.
    log.warn({ error: err }, "pool.list() failed during active-credential match");
    snapshot.fingerprint = fingerprint;
    return;
  }

  // Rotation-in-place: the live fingerprint changed since the last
  // observation and the OLD fingerprint still has a matching pool row.
  // Update that row's secret material in place via updateSecret() instead
  // of add() — see the file-level comment for why calling add() here (with
  // a fingerprint-derived name) used to mint a permanent orphaned duplicate
  // on every rotation.
  if (previousFingerprint && previousFingerprint !== fingerprint) {
    const existingRow = poolRows.find(
      (r) => r.fingerprint === previousFingerprint,
    );
    if (existingRow) {
      try {
        const parsedBlob = JSON.parse(plaintext) as object;
        const { expiresAt } = extractCredentialMetadata(plaintext);
        // Fall back to "already expired" (not a future guess) when the live
        // blob is missing expiresAt — the credential-refresh-job will pick
        // it up on its next tick rather than the row carrying a fabricated
        // expiry.
        const newExpiresAt = expiresAt ?? new Date();
        await pool.updateSecret(existingRow.id, parsedBlob, newExpiresAt);
        log.info(
          {
            path: resolvedPath,
            id: existingRow.id,
            previousFingerprint: previousFingerprint.slice(0, 8),
            fingerprint: fingerprint.slice(0, 8),
          },
          "active-credential: rotated token material updated in place",
        );
        snapshot.fingerprint = fingerprint;
      } catch (err) {
        log.warn(
          {
            path: resolvedPath,
            id: existingRow.id,
            error: err instanceof Error ? err.message : String(err),
          },
          "active-credential: failed to update rotated credential in place",
        );
        snapshot.fingerprint = null;
      }
      return;
    }
    // No pool row for the previous fingerprint (e.g. it was deleted) — fall
    // through to the add() path below, same as a genuine cold start.
  }

  // Mirror the live credential into the pool. pool.add() is idempotent (see
  // pool-core.ts's `(fingerprint, name)` re-import guard): a match updates
  // valueEncrypted/expiresAt/encryptionKeyId in place, preserving
  // status/leasedBy/cooldownUntil/isPrimary; a miss (cold-start, or a
  // rotation whose previous row is gone) inserts a new row. The auto-probe
  // inside add() hits api.anthropic.com with the LIVE access token and
  // populates accountEmail/Name/Uuid + organization fields on insert.
  try {
    await pool.add({
      id: randomUUID(),
      name: `acct-${fingerprint.slice(0, 8)}`,
      type: "oauth",
      value_plaintext: plaintext,
    });
    log.debug(
      {
        path: resolvedPath,
        fingerprint: fingerprint.slice(0, 8),
      },
      "active-credential: mirrored live credential into pool",
    );
  } catch (err) {
    // Graceful degrade: the snapshot keeps fingerprint=null so the UI
    // shows "active account not in pool" instead of falsely matching.
    // The next watcher tick will retry.
    log.warn(
      {
        path: resolvedPath,
        fingerprint: fingerprint.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      },
      "active-credential: failed to mirror credential into pool",
    );
    snapshot.fingerprint = null;
    return;
  }

  // Snapshot the LIVE fingerprint — the pool row is now guaranteed current.
  snapshot.fingerprint = fingerprint;
}

/**
 * Start the active-credential watcher.
 *
 * `credentialPath` defaults to `~/.claude/.credentials.json` in production;
 * tests pass an in-tmpdir path so the real fs.watch wiring below (not just
 * `runRefresh`'s parsing logic) gets exercised. `pollIntervalMs` defaults to
 * `POLL_INTERVAL_MS` (60s); tests pass a much shorter interval so the
 * poll-fallback path (see file-level doc comment, nx-6uzqi) doesn't require
 * a real 60s wait.
 *
 * Returns an AbortController; calling `abort()` stops the watcher, the poll
 * fallback, and resolves the outstanding `fs.watch` iterator.
 */
export function startActiveCredentialWatcher(
  pool: CredentialPool,
  credentialPath: string = CC_CREDENTIALS_PATH,
  pollIntervalMs: number = POLL_INTERVAL_MS,
): AbortController {
  const ac = new AbortController();
  // Watch the PARENT DIRECTORY, not the file itself (nx-6uzqi root cause).
  // Claude Code replaces .credentials.json atomically on token rotation AND
  // on account switch (`claude auth login`) -- most likely a temp-file+
  // rename swap, matching the "symlink swap works instantly" behaviour
  // recorded in project memory for how CC re-reads this file. A rename-over
  // (or symlink repoint) deletes the inode a single-file inotify watch is
  // bound to: the watch is invalidated (IN_IGNORED) and the fs.watch
  // iterator silently stops yielding further events -- no error, no more
  // scheduleRefresh() calls, ever -- freezing the snapshot at whatever
  // fingerprint was active before the switch until the agent restarts.
  // Watching the parent directory and filtering by filename survives this:
  // the watch is bound to the directory's stable inode, and directory-level
  // inotify events (create/rename/delete of an entry) fire regardless of
  // inode churn on the target file. This mirrors the pattern already used
  // by `startCredentialWatcher` in ./credential-watcher.ts for the sibling
  // pool directory -- same fix, same convention, applied here too.
  const credentialDir = dirname(credentialPath);
  const credentialFilename = basename(credentialPath);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function refresh(): Promise<void> {
    await runRefresh(pool, credentialPath);
    log.debug(
      {
        fingerprint: snapshot.fingerprint?.slice(0, 8) ?? null,
        resolvedPath: snapshot.resolvedPath,
      },
      "active credential snapshot updated",
    );
  }

  function scheduleRefresh(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      refresh().catch((err) => {
        log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "active credential refresh failed",
        );
      });
    }, DEBOUNCE_MS);
  }

  // Poll fallback (nx-6uzqi): unconditionally re-reads the live file on a
  // fixed cadence regardless of fs.watch. Started unconditionally (not
  // nested inside the fs.watch try/catch below) so it still bounds
  // staleness even if the directory doesn't exist yet or the watch loop
  // errors out. Cleared on abort via the signal listener, independent of
  // the debounce-timer cleanup in the finally block below.
  const pollTimer = setInterval(() => {
    refresh().catch((err) => {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "active credential poll-fallback refresh failed",
      );
    });
  }, pollIntervalMs);
  ac.signal.addEventListener("abort", () => clearInterval(pollTimer), {
    once: true,
  });

  (async () => {
    // Best-effort initial read — populates the snapshot before the first event.
    try {
      await refresh();
    } catch (err) {
      log.debug({ error: err }, "initial active credential read failed");
    }

    try {
      // Verify the directory exists before starting a watcher; `fs.watch` on
      // a missing path throws synchronously on some platforms. Checking the
      // DIRECTORY (not the file) also means the watcher now starts even
      // before the first `claude auth login` has ever created the
      // credentials file -- it'll pick up the create event once it lands.
      try {
        await stat(credentialDir);
      } catch {
        log.info(
          { dir: credentialDir },
          "active credential directory not found; watcher will not start",
        );
        return;
      }

      log.info(
        { dir: credentialDir, filename: credentialFilename },
        "active credential watcher started",
      );
      const watcher = watch(credentialDir, { signal: ac.signal });
      for await (const event of watcher) {
        if (event.filename !== credentialFilename) continue;
        scheduleRefresh();
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        log.info("active credential watcher stopped");
        return;
      }
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "active credential watcher terminated",
      );
    } finally {
      if (debounceTimer) clearTimeout(debounceTimer);
    }
  })();

  return ac;
}

/** Test-only: reset the in-memory snapshot. */
export function _resetActiveCredentialSnapshotForTest(): void {
  snapshot.fingerprint = null;
  snapshot.resolvedPath = null;
  snapshot.observedAt = new Date(0).toISOString();
}

/**
 * Test seam — exposes the rotation-import core so unit tests can drive it
 * with a fake pool + tmpdir credential path. Production paths in this file
 * continue to use `startActiveCredentialWatcher` / `getActiveCredentialSnapshot`.
 *
 * Spec: bd:nx-44mby tests.
 */
export const __testing = {
  runRefresh,
  resetSnapshot: _resetActiveCredentialSnapshotForTest,
  getSnapshot: getActiveCredentialSnapshot,
};
