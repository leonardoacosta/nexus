/**
 * Active-credential watcher.
 *
 * Watches `~/.claude/.credentials.json` (usually a symlink that Claude Code
 * swaps mid-session) and publishes the SHA-256 refresh-token fingerprint of
 * the currently-active credential so the Next.js credentials page can mark
 * exactly one account as "active for Claude Code".
 *
 * Behaviour:
 *   - Resolves the path via `fs.realpath()` on every change (follows symlinks).
 *   - Debounces watch events (200ms) — rotations can cause multiple fs events.
 *   - Computes the fingerprint via `computeCredentialFingerprint()` and matches
 *     it against the pool's DB rows. If no pool row matches, `fingerprint`
 *     becomes null (the user uses a credential nexus hasn't imported).
 *   - All failure modes — file missing, JSON parse error, no `refreshToken` —
 *     collapse to `fingerprint: null` without throwing, so the watcher never
 *     crashes the agent.
 *
 * The watcher runs in parallel with `startCredentialWatcher()`, which watches
 * the credential *pool* directory. The two watchers are independent.
 */

import { watch, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@nexus/core";
import {
  computeCredentialFingerprint,
  CredentialParseError,
} from "./credentials.helpers";
import type { CredentialPool } from "./pool";

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
 * Read `~/.claude/.credentials.json`, resolve its real path, compute the
 * refresh-token fingerprint, and — if the pool has a DB row with the same
 * fingerprint — return it. Returns `null` for every failure mode except
 * pool unavailability (which returns the computed fingerprint unmatched).
 */
async function readActiveFingerprint(
  pool: CredentialPool,
): Promise<{ fingerprint: string | null; resolvedPath: string | null }> {
  let resolvedPath: string | null = null;
  try {
    resolvedPath = await realpath(CC_CREDENTIALS_PATH);
  } catch (err) {
    // Fall back to reading the original path — realpath fails if the link
    // target is missing, but the file itself (if not a symlink) may still
    // be readable.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      resolvedPath = CC_CREDENTIALS_PATH;
    } else {
      log.debug({ path: CC_CREDENTIALS_PATH }, "active credential file missing");
      return { fingerprint: null, resolvedPath: null };
    }
  }

  let plaintext: string;
  try {
    plaintext = await readFile(resolvedPath ?? CC_CREDENTIALS_PATH, "utf-8");
  } catch (err) {
    log.debug(
      { path: resolvedPath, error: (err as Error).message },
      "failed to read active credential file",
    );
    return { fingerprint: null, resolvedPath };
  }

  let fingerprint: string;
  try {
    fingerprint = computeCredentialFingerprint(plaintext);
  } catch (err) {
    if (err instanceof CredentialParseError) {
      log.debug(
        { path: resolvedPath, error: err.message },
        "active credential file is not a valid OAuth blob",
      );
      return { fingerprint: null, resolvedPath };
    }
    throw err;
  }

  // Match against pool rows. pool.list() returns every credential with its
  // fingerprint; we return null when no row matches so the UI can render
  // "active account not in pool" gracefully.
  try {
    const rows = await pool.list();
    const match = rows.find((r) => r.fingerprint === fingerprint);
    return {
      fingerprint: match ? fingerprint : null,
      resolvedPath,
    };
  } catch (err) {
    // Pool read failed — return the computed fingerprint anyway; consumers
    // can at least tell that Claude Code is reading *something*.
    log.warn({ error: err }, "pool.list() failed during active-credential match");
    return { fingerprint, resolvedPath };
  }
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
    const result = await readActiveFingerprint(pool);
    snapshot.fingerprint = result.fingerprint;
    snapshot.resolvedPath = result.resolvedPath;
    snapshot.observedAt = new Date().toISOString();
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
