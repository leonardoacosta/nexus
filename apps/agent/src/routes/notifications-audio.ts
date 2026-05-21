/**
 * GET /notifications/:id/audio — stream the cached MP3 for a notification.
 *
 * Spec: openspec/changes/notifications-overhaul (task 2.5)
 *
 * Status codes:
 *   - 200 / 206  — file exists; full body or Range slice
 *   - 404        — no row, or row has NULL `audio_path`
 *   - 410        — row has `audio_path` set but the file was pruned
 *
 * Range support — implemented via Bun.file().slice(start, end) for the
 * `bytes=start-end` form (the only form Apple's AVAudioPlayer issues for
 * progressive playback). Other forms degrade to a full 200.
 */

import { existsSync, statSync } from "node:fs";
import type { Db } from "@nexus/db";
import { notifications as notificationsTable } from "@nexus/db";
import { eq } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:routes:notifications-audio");

const NOTIFICATION_ID_RE = /^[A-Za-z0-9._\-:]+$/;

export interface AudioRouteDeps {
  /**
   * Probe the disk for the given path. Defaults to the live `existsSync`
   * + `statSync` pair. Injectable so tests can simulate "row says file
   * exists but file is gone" without filesystem fixtures.
   */
  statFile?: (path: string) => { size: number } | null;
}

function defaultStat(path: string): { size: number } | null {
  if (!existsSync(path)) return null;
  try {
    const s = statSync(path);
    return s.isFile() ? { size: s.size } : null;
  } catch {
    return null;
  }
}

/**
 * Handle a GET /notifications/:id/audio request.
 * Returns a Response with the appropriate status + body.
 */
export async function handleNotificationAudio(
  db: Db,
  id: string,
  request: Request,
  deps: AudioRouteDeps = {},
): Promise<Response> {
  // 1. Sanity-check the id — refuse path traversal vectors.
  if (!id || !NOTIFICATION_ID_RE.test(id)) {
    return new Response(JSON.stringify({ error: "invalid notification id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 2. Look up the row.
  const rows = await db
    .select({
      id: notificationsTable.id,
      audioPath: notificationsTable.audioPath,
    })
    .from(notificationsTable)
    .where(eq(notificationsTable.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 3. Distinguish never-synthesised (404) from pruned (410).
  if (!row.audioPath) {
    return new Response(JSON.stringify({ error: "no audio" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stat = (deps.statFile ?? defaultStat)(row.audioPath);
  if (!stat) {
    log.info({ id, path: row.audioPath }, "audio file gone (pruned)");
    return new Response(JSON.stringify({ error: "audio gone" }), {
      status: 410,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 4. Range request? `bytes=start-end` is the only form we support.
  const range = request.headers.get("range");
  const file = Bun.file(row.audioPath);
  if (range) {
    const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] !== undefined ? Number(m[2]) : stat.size - 1;
      if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= 0 &&
        end < stat.size &&
        start <= end
      ) {
        const slice = file.slice(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            "Content-Type": "audio/mpeg",
            "Content-Range": `bytes ${start}-${end}/${stat.size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": String(end - start + 1),
          },
        });
      }
    }
    // Malformed / unsupported range — fall through to a full 200.
  }

  return new Response(file, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Accept-Ranges": "bytes",
      "Content-Length": String(stat.size),
    },
  });
}
