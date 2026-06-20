/**
 * Durable held-queue tests (openspec/changes/context-aware-routing).
 *
 * Requires a live PostgreSQL (POSTGRES_URL). Each suite runs in an isolated
 * schema so it never touches real data. Covers: persist, restart reload, flush
 * at holdUntil, released marker, and the PresenceHoldReleased emission.
 *
 *   cd apps/agent && POSTGRES_URL=... bun test src/notifications/held-queue.test.ts
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "bun:test";
import { createDb, type Db } from "@nexus/db";
import { HeldQueue } from "./held-queue";
import { lifecycleBus } from "../services/lifecycle-bus";
import type { PresenceHoldReleasedPayload } from "../services/lifecycle-bus";

import { hasLivePg as hasPg } from "../testing/live-pg";

const HQ_SCHEMA = `nx_hq_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const HQ_DDL = `
  CREATE TABLE "presence_holds" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL,
    "payload" jsonb NOT NULL,
    "hold_until" timestamptz NOT NULL,
    "reason" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "released_at" timestamptz
  );
`;

let adminSql: ReturnType<typeof createDb>["client"];
let scopedDb: Db;
let scopedClient: ReturnType<typeof createDb>["client"];
/**
 * Set when a sibling test file has globally `mock.module("@nexus/db")`'d
 * `createDb` to a stub (Bun mocks are process-global + irreversible). In that
 * case `adminSql.unsafe` is absent and the live-PG path is meaningless, so we
 * skip rather than throw an unhandled error mid-suite.
 */
let skipDueToMock = false;

describe.skipIf(!hasPg)("HeldQueue (requires live PG)", () => {
  beforeAll(async () => {
    const url = process.env.POSTGRES_URL!;
    const adminHandle = createDb(url);
    adminSql = adminHandle.client;
    if (typeof (adminSql as { unsafe?: unknown })?.unsafe !== "function") {
      skipDueToMock = true;
      return;
    }
    await adminSql.unsafe(`CREATE SCHEMA "${HQ_SCHEMA}"`);
    await adminSql.unsafe(`SET search_path TO "${HQ_SCHEMA}", public`);
    await adminSql.unsafe(HQ_DDL);

    const scopedHandle = createDb(url, {
      connection: { search_path: `"${HQ_SCHEMA}",public` },
    });
    scopedClient = scopedHandle.client;
    scopedDb = scopedHandle.db;
  });

  afterAll(async () => {
    if (skipDueToMock) return;
    try {
      await scopedClient.end({ timeout: 5 });
    } finally {
      try {
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS "${HQ_SCHEMA}" CASCADE`);
      } finally {
        await adminSql.end({ timeout: 5 });
      }
    }
  });

  beforeEach(async () => {
    if (skipDueToMock) return;
    await adminSql.unsafe(`TRUNCATE "${HQ_SCHEMA}"."presence_holds"`);
    lifecycleBus.removeAllListeners();
  });

  it("persists a hold to presence_holds", async () => {
    if (skipDueToMock) return;
    const q = new HeldQueue(scopedDb, "leo");
    await q.hold({
      id: "hold-1",
      payload: { title: "Build done", body: "wave 1" },
      holdUntil: new Date(Date.now() + 60_000),
      reason: "rule-2-meeting",
    });

    const rows = await adminSql.unsafe(
      `SELECT id, user_id, released_at FROM "${HQ_SCHEMA}".presence_holds WHERE id = 'hold-1'`,
    ) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe("leo");
    expect(rows[0]!.released_at).toBeNull();
  });

  it("reloads pending holds on restart (loadPending)", async () => {
    if (skipDueToMock) return;
    // Seed a pending hold directly.
    await adminSql.unsafe(`
      INSERT INTO "${HQ_SCHEMA}".presence_holds (id, user_id, payload, hold_until)
      VALUES ('hold-reload', 'leo', '{"title":"X"}'::jsonb, now() + interval '1 hour')
    `);

    const q = new HeldQueue(scopedDb, "leo");
    const pending = await q.loadPending();
    expect(pending.map((p) => p.id)).toContain("hold-reload");
  });

  it("flush marks released_at and emits PresenceHoldReleased", async () => {
    if (skipDueToMock) return;
    const released: PresenceHoldReleasedPayload[] = [];
    lifecycleBus.on("PresenceHoldReleased", (e) => released.push(e.payload));

    const q = new HeldQueue(scopedDb, "leo");
    await q.hold({
      id: "hold-flush",
      payload: { title: "Y" },
      holdUntil: new Date(Date.now() - 1_000), // already due
      reason: "rule-2-meeting",
    });

    const flushed = await q.flush("hold-flush");
    expect(flushed?.id).toBe("hold-flush");

    const rows = await adminSql.unsafe(
      `SELECT released_at FROM "${HQ_SCHEMA}".presence_holds WHERE id = 'hold-flush'`,
    ) as Array<Record<string, unknown>>;
    expect(rows[0]!.released_at).not.toBeNull();

    expect(released.map((r) => r.id)).toContain("hold-flush");
  });

  it("flushDue flushes every hold whose holdUntil has passed", async () => {
    if (skipDueToMock) return;
    const released: string[] = [];
    lifecycleBus.on("PresenceHoldReleased", (e) => released.push(e.payload.id));

    const q = new HeldQueue(scopedDb, "leo");
    await q.hold({
      id: "due-1",
      payload: { title: "A" },
      holdUntil: new Date(Date.now() - 1_000),
    });
    await q.hold({
      id: "future-1",
      payload: { title: "B" },
      holdUntil: new Date(Date.now() + 60 * 60_000),
    });

    const flushed = await q.flushDue();
    expect(flushed.map((f) => f.id)).toContain("due-1");
    expect(flushed.map((f) => f.id)).not.toContain("future-1");
    expect(released).toContain("due-1");
    expect(released).not.toContain("future-1");
  });
});
