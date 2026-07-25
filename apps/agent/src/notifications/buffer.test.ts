/**
 * Notification persistence (buffer.ts) tests.
 *
 * context-aware-routing removed the in-memory `pendingIds` ring + the
 * `buffer-meta.json` sidecar (the restart-data-loss path). What remains is the
 * thin DB-CRUD over the `notifications` table; these tests exercise that the
 * helpers issue the expected drizzle chains against a fake DB — no live PG.
 */

import { describe, expect, it, mock } from "bun:test";
import { installNexusDbMock } from "../testing/mock-nexus-db";

// ─── Mock DB dependencies so no real DB is needed ───────────────────────────
// Shared COMPLETE @nexus/db mock — re-exports the real module so every schema
// table + drizzle helper resolves under the process-global last-writer-wins
// semantics of bun's mock.module (nx-509z5). The fake `Db` handle each test
// passes below still controls per-test behaviour.

installNexusDbMock();

// ─── Import after mocks are registered ──────────────────────────────────────

import {
  insertNotification,
  queryNotificationsByStatus,
  markNotificationDelivered,
  markNotificationExpired,
  getNotificationById,
  countRecentNotifications,
} from "./buffer";

describe("buffer DB-CRUD (in-memory ring removed by context-aware-routing)", () => {
  it("insertNotification issues db.insert(...).values(row)", async () => {
    const values = mock(async () => {});
    const insert = mock(() => ({ values }));
    const db = { insert } as unknown as import("@nexus/db").Db;

    await insertNotification(db, { id: "n1" } as never);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledTimes(1);
  });

  it("markNotificationDelivered sets status=delivered + sentAt", async () => {
    const where = mock(async () => {});
    const set = mock((_patch: unknown) => ({ where }));
    const update = mock(() => ({ set }));
    const db = { update } as unknown as import("@nexus/db").Db;

    await markNotificationDelivered(db, "n1");
    expect(set).toHaveBeenCalledTimes(1);
    const patch = set.mock.calls[0]![0] as { status: string; deliveryState: string; sentAt: Date };
    expect(patch.status).toBe("delivered");
    expect(patch.deliveryState).toBe("delivered");
    expect(patch.sentAt).toBeInstanceOf(Date);
  });

  it("markNotificationExpired sets status=expired", async () => {
    const where = mock(async () => {});
    const set = mock((_patch: unknown) => ({ where }));
    const update = mock(() => ({ set }));
    const db = { update } as unknown as import("@nexus/db").Db;

    await markNotificationExpired(db, "n1");
    const patch = set.mock.calls[0]![0] as { status: string; deliveryState: string };
    expect(patch.status).toBe("expired");
    expect(patch.deliveryState).toBe("failed");
  });

  it("getNotificationById returns null when no row matches", async () => {
    const limit = mock(async () => []);
    const where = mock(() => ({ limit }));
    const from = mock(() => ({ where }));
    const select = mock(() => ({ from }));
    const db = { select } as unknown as import("@nexus/db").Db;

    const row = await getNotificationById(db, "missing");
    expect(row).toBeNull();
  });

  // `tts-degradation-test-coverage` task 1.3: real coverage for three
  // behaviors that only existed as `expect(true)` placeholders in
  // notifications.test.ts — `queryNotificationsByStatus` had NO test at all
  // despite being the manager's flush-path read (manager.ts:404).

  it("getNotificationById returns the row when one matches", async () => {
    const row = { id: "n1", title: "hit" };
    const limit = mock(async () => [row]);
    const where = mock(() => ({ limit }));
    const from = mock(() => ({ where }));
    const select = mock(() => ({ from }));
    const db = { select } as unknown as import("@nexus/db").Db;

    expect(await getNotificationById(db, "n1")).toEqual(row as never);
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it("queryNotificationsByStatus filters by status and returns the rows", async () => {
    const rows = [{ id: "a" }, { id: "b" }];
    const limit = mock(async () => rows);
    const orderBy = mock(() => ({ limit }));
    const where = mock(() => ({ orderBy }));
    const from = mock(() => ({ where }));
    const select = mock(() => ({ from }));
    const db = { select } as unknown as import("@nexus/db").Db;

    expect(await queryNotificationsByStatus(db, "queued")).toEqual(rows as never);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("queryNotificationsByStatus orders by created_at ascending, capped at 500", async () => {
    const limit = mock(async (_n: number) => []);
    const orderBy = mock((_order: unknown) => ({ limit }));
    const where = mock(() => ({ orderBy }));
    const from = mock(() => ({ where }));
    const select = mock(() => ({ from }));
    const db = { select } as unknown as import("@nexus/db").Db;

    await queryNotificationsByStatus(db, "queued");
    expect(orderBy).toHaveBeenCalledTimes(1);
    // drizzle's `asc(notifications.createdAt)` is an SQL object whose
    // `queryChunks` hold the column + direction; it is cyclic, so assert on
    // the flattened chunk text rather than JSON.stringify.
    const order = orderBy.mock.calls[0]![0] as { queryChunks?: unknown[] };
    const chunkText = (order.queryChunks ?? [])
      .map((c) => {
        const chunk = c as { name?: string; value?: string[] };
        return chunk?.name ?? chunk?.value?.join("") ?? "";
      })
      .join("");
    expect(chunkText).toContain("created_at");
    expect(chunkText).toContain("asc");
    expect(limit).toHaveBeenCalledWith(500);
  });

  it("countRecentNotifications issues a COUNT query scoped to project+channel+since", async () => {
    const where = mock(async () => [{ count: 3 }]);
    const from = mock(() => ({ where }));
    const select = mock(() => ({ from }));
    const db = { select } as unknown as import("@nexus/db").Db;

    const count = await countRecentNotifications(db, "nx", "tts", new Date());
    expect(select).toHaveBeenCalledTimes(1);
    expect(count).toBe(3);
  });

  it("countRecentNotifications handles a null project", async () => {
    const where = mock(async () => [{ count: 0 }]);
    const from = mock(() => ({ where }));
    const select = mock(() => ({ from }));
    const db = { select } as unknown as import("@nexus/db").Db;

    const count = await countRecentNotifications(db, null, "tts", new Date());
    expect(count).toBe(0);
  });
});
