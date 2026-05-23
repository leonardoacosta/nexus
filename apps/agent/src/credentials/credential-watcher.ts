import { watch, readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { logger } from "@nexus/core/node";
import type { CredentialPool } from "./pool";
import {
  computeCredentialFingerprint,
  CredentialParseError,
} from "./credentials.helpers";
import { randomUUID } from "node:crypto";

// Re-export the active-credential watcher so callers can start both
// watchers via a single import surface. The active watcher tracks the
// symlink at `~/.claude/.credentials.json`; the pool watcher below tracks
// the credential *directory* for new/changed pool files.
export {
  startActiveCredentialWatcher,
  getActiveCredentialSnapshot,
} from "./active-credential-watcher";
export type { ActiveCredentialSnapshot } from "./active-credential-watcher";

const DEBOUNCE_MS = 200;
const CRED_DIR = join(process.env.HOME ?? "", ".config/nexus/credentials");

/**
 * Minimal CredentialPool surface the watcher actually uses. Declared as
 * a structural Pick<> so the unit tests can inject a fake pool that only
 * implements these two methods without needing a real DB.
 */
type WatcherPool = Pick<CredentialPool, "add" | "refreshMetadata">;

/** Outcome of processing a single credential file. */
type ProcessResult = "added" | "refreshed" | "skipped";

/**
 * Process one credential file: validate, dedupe by fingerprint, then
 * either insert (pool.add) or refresh metadata (pool.refreshMetadata).
 *
 * Used by BOTH the initial-scan phase and the fs.watch event loop so
 * they share dedupe semantics. Returns the outcome so callers can
 * aggregate counts.
 */
async function processCredentialFile(
  pool: WatcherPool,
  filePath: string,
  filename: string,
): Promise<ProcessResult> {
  let plaintext: string;
  try {
    plaintext = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File disappeared between dir-listing and open; treat as skip.
      return "skipped";
    }
    throw err;
  }

  // Validate JSON structure
  try {
    JSON.parse(plaintext);
  } catch {
    logger.warn(
      { file: filename },
      "credential watcher: file is not valid JSON",
    );
    return "skipped";
  }

  // Validate credential shape via fingerprint computation.
  try {
    computeCredentialFingerprint(plaintext);
  } catch (err) {
    if (err instanceof CredentialParseError) {
      logger.warn(
        { file: filename, error: err.message },
        "credential watcher: invalid credential file",
      );
      return "skipped";
    }
    throw err;
  }

  // Insert. On duplicate fingerprint, fall through to metadata refresh
  // so updated token expiry etc. are picked up. (handleFileEvent kept
  // the same semantics; the initial-scan phase inherits them by
  // routing through this helper.)
  try {
    await pool.add({
      id: randomUUID(),
      name: basename(filename, ".json"),
      type: "oauth",
      value_plaintext: plaintext,
    });
    return "added";
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("duplicate") || err.message.includes("unique"))
    ) {
      await pool.refreshMetadata();
      return "refreshed";
    }
    throw err;
  }
}

/**
 * Outcome of an initial-scan pass over the credential directory.
 *
 * Numbers MUST equal `added + refreshed + skipped == scanned` — the
 * watcher tests assert this invariant.
 */
export interface InitialScanResult {
  /** Number of `acct-*.json` files visited. */
  scanned: number;
  /** Files for which `pool.add()` succeeded as a new row. */
  added: number;
  /** Files whose fingerprint matched an existing row → metadata refresh. */
  refreshed: number;
  /** Files we skipped (invalid JSON, missing refreshToken, ENOENT). */
  skipped: number;
}

/**
 * Initial-scan phase — process every existing `acct-*.json` file in
 * `credDir` exactly once.
 *
 * Why: `fs.watch` only fires for files modified AFTER the watcher
 * starts. In production all credential files exist at agent start time,
 * so without this scan the DB stays empty and `/credentials` falls
 * back to the legacy filesystem shape (no usage5h, no siblingCount).
 * Spec: bd:nx-wo9f9.
 *
 * Exported so tests can drive it directly with a fake pool.
 *
 * Missing `credDir` is a no-op (fresh agent installs that haven't
 * registered any credentials yet).
 */
export async function runInitialScan(
  pool: WatcherPool,
  credDir: string = CRED_DIR,
): Promise<InitialScanResult> {
  const result: InitialScanResult = {
    scanned: 0,
    added: 0,
    refreshed: 0,
    skipped: 0,
  };

  let entries: string[];
  try {
    entries = await readdir(credDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Fresh install: directory hasn't been created yet. Not an error.
      return result;
    }
    throw err;
  }

  const credentialFiles = entries
    .filter((f) => f.startsWith("acct-") && f.endsWith(".json"))
    .sort();

  for (const filename of credentialFiles) {
    result.scanned += 1;
    try {
      const outcome = await processCredentialFile(
        pool,
        join(credDir, filename),
        filename,
      );
      if (outcome === "added") result.added += 1;
      else if (outcome === "refreshed") result.refreshed += 1;
      else result.skipped += 1;
    } catch (err) {
      result.skipped += 1;
      logger.warn(
        {
          file: filename,
          error: err instanceof Error ? err.message : String(err),
        },
        "credential watcher: initial scan failed for file",
      );
    }
  }

  return result;
}

/**
 * Watch the credential directory for file changes.
 * - On startup: scan + import every existing `acct-*.json` (nx-wo9f9).
 * - New acct-*.json -> pool.add()
 * - Changed acct-*.json -> pool.refreshMetadata() for that file
 * - Deleted -> log warning, do not remove DB rows
 *
 * Returns an AbortController to stop watching.
 */
export function startCredentialWatcher(
  pool: CredentialPool,
  options?: { credDir?: string },
): AbortController {
  const ac = new AbortController();
  const credDir = options?.credDir ?? CRED_DIR;

  // Debounce map: filename -> timeout handle
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  async function handleFileEvent(filename: string) {
    if (!filename.startsWith("acct-") || !filename.endsWith(".json")) return;

    const filePath = join(credDir, filename);
    try {
      const outcome = await processCredentialFile(pool, filePath, filename);
      if (outcome === "added") {
        logger.info(
          { file: filename },
          "credential watcher: new credential imported",
        );
      } else if (outcome === "refreshed") {
        logger.info(
          { file: filename },
          "credential watcher: metadata refreshed for existing credential",
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // File was deleted between event firing and read.
        logger.warn(
          { file: filename },
          "credential watcher: file deleted -- DB row retained",
        );
        return;
      }
      logger.warn(
        {
          file: filename,
          error: err instanceof Error ? err.message : String(err),
        },
        "credential watcher: failed to process file event",
      );
    }
  }

  (async () => {
    try {
      // Initial scan (bd:nx-wo9f9) — process every credential file that
      // already exists on disk BEFORE the watch loop starts. Without
      // this, fs.watch would never see those files (it only fires for
      // post-start mutations), the credentials table would stay empty,
      // and the /credentials route would fall back to the legacy
      // filesystem shape that lacks usage5h / siblingCount.
      const scan = await runInitialScan(pool, credDir);
      logger.info(
        {
          dir: credDir,
          ...scan,
        },
        "credential watcher: initial scan complete",
      );

      // Now start the live watcher for post-start mutations.
      const watcher = watch(credDir, { signal: ac.signal });
      logger.info({ dir: credDir }, "credential watcher started");

      for await (const event of watcher) {
        const filename = event.filename;
        if (!filename) continue;

        // Debounce: clear any existing timeout for this file, set a new one
        const existing = pending.get(filename);
        if (existing) clearTimeout(existing);

        pending.set(
          filename,
          setTimeout(() => {
            pending.delete(filename);
            handleFileEvent(filename).catch((err) => {
              logger.warn(
                {
                  file: filename,
                  error: err instanceof Error ? err.message : String(err),
                },
                "credential watcher: unhandled error in file handler",
              );
            });
          }, DEBOUNCE_MS),
        );
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        logger.info("credential watcher stopped");
        return;
      }
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "credential watcher: failed to start -- directory may not exist",
      );
    }
  })();

  return ac;
}
