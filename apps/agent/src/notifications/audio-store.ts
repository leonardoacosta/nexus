/**
 * audio-store — cache notification MP3 bytes on the local filesystem.
 *
 * Spec: openspec/changes/notifications-overhaul (task 2.1)
 *
 * Files live at `~/.config/nexus/audio/<id>.mp3`. Filesystem chosen over
 * a DB blob for streaming efficiency (HTTP range requests + zero DB IO
 * per replay). The retention sweep (cron `maintain` job, 30-day mtime
 * threshold) prunes stale files. The `notifications.audio_path` column
 * may drift out of sync with the filesystem (file pruned, row retained);
 * `audioExists()` is the authoritative liveness check.
 */

import { existsSync, statSync, unlinkSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:notifications:audio-store");

/**
 * Resolve the directory holding cached MP3 files. Honors `NEXUS_CONFIG_DIR`
 * for tests + sandboxed environments — falls back to `~/.config/nexus`.
 */
export function audioDir(): string {
  const configDir =
    process.env.NEXUS_CONFIG_DIR ??
    join(process.env.HOME ?? homedir(), ".config", "nexus");
  return join(configDir, "audio");
}

/**
 * Resolve the canonical mp3 path for a notification id.
 * Pure: does NOT stat the filesystem.
 */
export function audioPathFor(notificationId: string): string {
  // Sanitise the id slightly — drop path separators so a bad caller can't
  // escape the audio dir. We don't enforce a strict regex here because
  // notification ids come from the agent's own generator + opaque GUIDs.
  const safe = notificationId.replace(/[/\\]/g, "_");
  return join(audioDir(), `${safe}.mp3`);
}

/**
 * Persist MP3 bytes for a notification id and return the absolute path.
 * Creates the audio directory on first write (idempotent).
 */
export async function writeAudio(
  notificationId: string,
  mp3Bytes: Uint8Array | Buffer,
): Promise<string> {
  const path = audioPathFor(notificationId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, mp3Bytes);
  log.debug({ notificationId, bytes: mp3Bytes.byteLength }, "audio-store: wrote mp3");
  return path;
}

/**
 * Return the canonical path for a notification if the file currently
 * exists on disk, else null. Stat-based (cheap; no read).
 */
export function readAudioPath(notificationId: string): string | null {
  const path = audioPathFor(notificationId);
  return existsSync(path) ? path : null;
}

/**
 * Cheap existence probe — used by `/notifications` to set
 * `audioAvailable` per row without round-tripping the file bytes.
 */
export function audioExists(notificationId: string): boolean {
  return existsSync(audioPathFor(notificationId));
}

export interface PruneResult {
  count: number;
  bytes: number;
}

/**
 * Delete every `*.mp3` file in the audio dir older than `days` (mtime).
 * Returns a summary count for cron logging. Safe to call when the dir
 * does not exist (zero result).
 */
export function pruneAudioOlderThan(days: number): PruneResult {
  const dir = audioDir();
  if (!existsSync(dir)) return { count: 0, bytes: 0 };

  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  let count = 0;
  let bytes = 0;

  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".mp3")) continue;
      const full = join(dir, entry);
      try {
        const s = statSync(full);
        if (!s.isFile()) continue;
        if (s.mtimeMs > cutoffMs) continue;
        bytes += s.size;
        unlinkSync(full);
        count++;
        log.debug({ path: full }, "audio-store: pruned");
      } catch {
        // unreadable / locked file — skip silently
      }
    }
  } catch {
    // dir vanished mid-scan — non-fatal
  }

  return { count, bytes };
}
