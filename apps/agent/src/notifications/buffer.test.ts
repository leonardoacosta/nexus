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
  markNotificationDelivered,
  markNotificationExpired,
  getNotificationById,
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
    const set = mock(() => ({ where }));
    const update = mock(() => ({ set }));
    const db = { update } as unknown as import("@nexus/db").Db;

    await markNotificationDelivered(db, "n1");
    expect(set).toHaveBeenCalledTimes(1);
    const patch = set.mock.calls[0]![0] as { status: string; sentAt: Date };
    expect(patch.status).toBe("delivered");
    expect(patch.sentAt).toBeInstanceOf(Date);
  });

  it("markNotificationExpired sets status=expired", async () => {
    const where = mock(async () => {});
    const set = mock(() => ({ where }));
    const update = mock(() => ({ set }));
    const db = { update } as unknown as import("@nexus/db").Db;

    await markNotificationExpired(db, "n1");
    const patch = set.mock.calls[0]![0] as { status: string };
    expect(patch.status).toBe("expired");
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
});
