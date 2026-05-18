/**
 * Transcript Locator
 *
 * Computes the path to a Claude Code session's transcript JSONL file
 * and waits up to 5 seconds for it to appear if it doesn't exist yet.
 *
 * Path convention:
 *   ~/.claude/projects/<encoded-cwd>/<cc_session_id>.jsonl
 * where encoded-cwd replaces '/' with '-' (leading '-' from the
 * leading '/' in the cwd is kept — that's how CC encodes it).
 */

import { existsSync, watch, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:token-stream:locator");

/** How long to wait for the transcript file to appear (ms). */
const WATCH_TIMEOUT_MS = 5_000;

/**
 * Locate the transcript JSONL file for a Claude Code session.
 *
 * @param cwd         - The working directory of the session (e.g. "/home/user/dev/nx")
 * @param ccSessionId - The Claude Code session UUID
 * @returns The absolute path to the transcript file, or null if not found within 5s.
 */
export async function locateTranscript(
  cwd: string,
  ccSessionId: string,
): Promise<string | null> {
  const encodedCwd = cwd.replaceAll("/", "-");
  const parentDir = path.join(homedir(), ".claude", "projects", encodedCwd);
  const fileName = `${ccSessionId}.jsonl`;
  const filePath = path.join(parentDir, fileName);

  // Fast path: file already exists
  if (existsSync(filePath)) {
    log.debug({ ccSessionId, filePath }, "transcript found immediately");
    return filePath;
  }

  // Ensure parent directory exists before watching
  if (!existsSync(parentDir)) {
    try {
      mkdirSync(parentDir, { recursive: true });
    } catch {
      // Directory may have been created concurrently — that's fine
    }
  }

  // Slow path: watch the parent directory for up to 5 seconds
  return new Promise<string | null>((resolve) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      watcher.close();
      log.warn(
        { ccSessionId, cwd, path: filePath },
        "transcript not found within 5s, skipping token tracking",
      );
      resolve(null);
    }, WATCH_TIMEOUT_MS);

    const watcher = watch(parentDir, (eventType, eventFileName) => {
      if (resolved) return;
      if (eventFileName === fileName) {
        resolved = true;
        clearTimeout(timeout);
        watcher.close();
        log.debug({ ccSessionId, filePath }, "transcript appeared via fs.watch");
        resolve(filePath);
      }
    });

    watcher.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      watcher.close();
      log.warn(
        { ccSessionId, err },
        "fs.watch error while waiting for transcript, skipping token tracking",
      );
      resolve(null);
    });

    // Double-check after setting up the watcher (race window)
    if (existsSync(filePath)) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        watcher.close();
        log.debug({ ccSessionId, filePath }, "transcript found after watcher setup");
        resolve(filePath);
      }
    }
  });
}
