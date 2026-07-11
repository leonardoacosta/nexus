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
 *   - Computes the fingerprint via `computeCredentialFingerprint()` and calls
 *     `pool.add()` UNCONDITIONALLY with the live plaintext — not only when the
 *     fingerprint is missing from the pool. `pool.add()` is idempotent: a
 *     `(fingerprint, name)` match updates the existing row in place
 *     (`valueEncrypted`/`expiresAt`/`encryptionKeyId`), a miss inserts a new
 *     row. This matters because `fingerprint = SHA256(refreshToken)` stays
 *     identical across an ACCESS-token-only refresh (Claude Code rotates the
 *     access token far more often than the refresh token) — gating `add()`
 *     behind "fingerprint not already in the pool" meant a credential's
 *     stale access token was written once on import and never updated again,
 *     even though Claude Code kept the live file current. That was the root
 *     cause of `credential-usage-poller` failing on every poll: it was
 *     always sending an access token that expired hours or days earlier.
 *     The auto-probe inside `pool.add()` hits api.anthropic.com (a
 *     different, un-throttled endpoint from the OAuth refresh-grant below)
 *     with the fresh access token and populates
 *     accountEmail/Name/Uuid/orgName/orgUuid for the row.
 *   - All failure modes — file missing, JSON parse error, no `refreshToken`,
 *     pool.add() exception — collapse to `fingerprint: null` without throwing,
 *     so the watcher never crashes the agent.
 *
 * The watcher runs in parallel with `startCredentialWatcher()`, which watches
 * the credential *pool* directory at `~/.config/nexus/credentials/`. The pool
 * directory contains snapshots that quickly go stale because Claude Code
 * rotates refresh tokens; this watcher is the one that keeps the pool in
 * sync with Claude Code's live rotation cadence.
 */

import { watch, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLogger } from "@nexus/core/node";
import {
  computeCredentialFingerprint,
  CredentialParseError,
} from "./credentials.helpers";
import type { CredentialPool } from "./pool";

/**
 * Minimal pool surface the watcher consumes. Tests inject a fake satisfying
 * just `list()` and `add()` — no DB or encryption setup required.
 */
type WatcherPool = {
  list: () => Promise<Array<{ id: string; fingerprint: string | null }>>;
  add: (input: {
    id: string;
    name: string;
    type: string;
    value_plaintext: string;
  }) => Promise<"inserted" | "updated">;
};

const log = createLogger("agent:active-credential-watcher");

const DEBOUNCE_MS = 200;
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

  // Down-detection only: confirm the pool is reachable before writing to it.
  // The row list itself is no longer consulted to decide whether to call
  // pool.add() — see the file-level comment for why gating on "fingerprint
  // already in the pool" was the bug.
  try {
    await pool.list();
  } catch (err) {
    // Pool read failed — surface the LIVE fingerprint anyway so the UI can
    // distinguish "Claude Code is up" from "Claude Code is down". Cannot
    // safely write; snapshot retains the unmatched live fingerprint.
    log.warn({ error: err }, "pool.list() failed during active-credential match");
    snapshot.fingerprint = fingerprint;
    return;
  }

  // Mirror the live credential into the pool UNCONDITIONALLY, on every
  // observation — not only on a fingerprint miss. pool.add() is idempotent
  // (see pool-core.ts's `(fingerprint, name)` re-import guard): a match
  // updates valueEncrypted/expiresAt/encryptionKeyId in place, preserving
  // status/leasedBy/cooldownUntil/isPrimary; a miss (real rotation, or
  // cold-start) inserts a new row. The auto-probe inside add() hits
  // api.anthropic.com with the LIVE access token and populates
  // accountEmail/Name/Uuid + organization fields on insert.
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
 * Returns an AbortController; calling `abort()` stops the watcher and
 * resolves the outstanding `fs.watch` iterator.
 */
export function startActiveCredentialWatcher(
  pool: CredentialPool,
): AbortController {
  const ac = new AbortController();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function refresh(): Promise<void> {
    await runRefresh(pool, CC_CREDENTIALS_PATH);
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

  (async () => {
    // Best-effort initial read — populates the snapshot before the first event.
    try {
      await refresh();
    } catch (err) {
      log.debug({ error: err }, "initial active credential read failed");
    }

    try {
      // Verify the file exists before starting a watcher; `fs.watch` on a
      // missing file throws synchronously on some platforms.
      try {
        await stat(CC_CREDENTIALS_PATH);
      } catch {
        log.info(
          { path: CC_CREDENTIALS_PATH },
          "active credential file not found; watcher will not start",
        );
        return;
      }

      log.info({ path: CC_CREDENTIALS_PATH }, "active credential watcher started");
      const watcher = watch(CC_CREDENTIALS_PATH, { signal: ac.signal });
      for await (const _event of watcher) {
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
