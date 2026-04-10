import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { Db } from "@nexus/db";
import { notifications } from "@nexus/db";
import type { NotificationStatus } from "@nexus/core";
import { createLogger } from "@nexus/core";
import { eq, asc } from "drizzle-orm";

const log = createLogger("agent:notifications:buffer");

/** Maximum number of in-flight notification records tracked in memory. */
export const MAX_BUFFER_SIZE = 1000;

/** In-memory ring buffer of pending notification ids (LRU eviction at cap). */
const pendingIds: string[] = [];

// ---------------------------------------------------------------------------
// Buffer metadata persistence (D9)
// ---------------------------------------------------------------------------

export interface BufferMeta {
  count: number;
  watermark: number;
  lastFlushMs: number;
}

function metaPath(): string {
  const configDir =
    process.env.NEXUS_CONFIG_DIR ??
    join(process.env.HOME ?? "/tmp", ".config", "nexus");
  return join(configDir, "buffer-meta.json");
}

/** Write current buffer metadata to the sidecar file. */
async function persistMeta(): Promise<void> {
  try {
    const existing = await readMeta();
    const meta: BufferMeta = {
      count: pendingIds.length,
      watermark: Math.max(pendingIds.length, existing?.watermark ?? 0),
      lastFlushMs: Date.now(),
    };
    const p = metaPath();
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, JSON.stringify(meta), "utf8");
  } catch (err) {
    log.warn({ err }, "buffer: failed to persist metadata (non-fatal)");
  }
}

/** Read persisted metadata, or null if not present / parse error. */
export async function readMeta(): Promise<BufferMeta | null> {
  try {
    const raw = await readFile(metaPath(), "utf8");
    return JSON.parse(raw) as BufferMeta;
  } catch {
    return null;
  }
}

/** Hydrate in-memory state from persisted metadata on module load. */
void (async function hydrateOnLoad() {
  const meta = await readMeta();
  if (meta) {
    log.info(
      { count: meta.count, watermark: meta.watermark, lastFlushMs: meta.lastFlushMs },
      "buffer: hydrated metadata from sidecar",
    );
  }
})();

/** Row shape returned from the `notifications` table. */
export type NotificationRow = typeof notifications.$inferSelect;

/** Insert a notification into the buffer, evicting the oldest entry if at capacity. */
export async function insertNotification(db: Db, row: NotificationRow): Promise<void> {
  if (pendingIds.length >= MAX_BUFFER_SIZE) {
    const dropped = pendingIds.shift();
    log.warn({ dropped }, "notification buffer eviction");
  }
  pendingIds.push(row.id);
  await db.insert(notifications).values(row);
  await persistMeta();
}

/** Query all notifications with a given status. */
export async function queryNotificationsByStatus(
  db: Db,
  status: NotificationStatus,
): Promise<NotificationRow[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.status, status))
    .orderBy(asc(notifications.createdAt));
}

/** Mark a notification as delivered. */
export async function markNotificationDelivered(db: Db, id: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: "delivered", sentAt: new Date() })
    .where(eq(notifications.id, id));
  // Remove from in-memory ring buffer and persist updated metadata.
  const idx = pendingIds.indexOf(id);
  if (idx !== -1) pendingIds.splice(idx, 1);
  await persistMeta();
}

/** Mark a notification as expired. */
export async function markNotificationExpired(db: Db, id: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: "expired" })
    .where(eq(notifications.id, id));
  // Remove from in-memory ring buffer and persist updated metadata.
  const idx = pendingIds.indexOf(id);
  if (idx !== -1) pendingIds.splice(idx, 1);
  await persistMeta();
}

/** Get a single notification by id. */
export async function getNotificationById(
  db: Db,
  id: string,
): Promise<NotificationRow | null> {
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.id, id))
    .limit(1);
  return rows[0] ?? null;
}
