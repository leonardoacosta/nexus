/**
 * Contract tests for handleNotificationAudio.
 *
 * Spec: openspec/changes/notifications-overhaul (task 2.6)
 *
 * Five scenarios per spec:
 *   - 200 full body
 *   - 206 range
 *   - 404 no row
 *   - 404 no audio_path
 *   - 410 path set but file missing
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Db } from "@nexus/db";
import { handleNotificationAudio } from "./notifications-audio";

interface FakeRow {
  id: string;
  audioPath: string | null;
}

function makeFakeDb(rows: FakeRow[]): Db {
  const builder = {
    _filterId: null as string | null,
    from() {
      return this;
    },
    where(predicate: unknown) {
      // Drizzle wraps the predicate in an opaque SQL object; we cheat
      // here and extract the id from the call site by stashing it on
      // the builder via a helper. Real-world tests prefer a small SQL
      // recorder, but for this route a single `eq(id, ...)` clause is
      // the only shape that ever reaches us.
      this._filterId = String((predicate as { _id?: string })._id ?? "");
      return this;
    },
    limit(): Promise<FakeRow[]> {
      const match = rows.find((r) => r.id === this._filterId);
      return Promise.resolve(match ? [match] : []);
    },
  };
  return {
    select(): typeof builder {
      return { ...builder, _filterId: null };
    },
  } as unknown as Db;
}

// The drizzle `eq` predicate is opaque — patch the route's filter check
// by injecting a small id-extracting predicate at call time. We achieve
// this by wrapping `db.select().where(eq(id, X))` such that the test
// builder reads X from the predicate. The shim below intercepts eq()
// at the route boundary using a custom Db.
function makeDbWithId(rows: FakeRow[]): Db {
  const select = (): unknown => ({
    from(): unknown {
      return {
        where(pred: { idValue?: string }): unknown {
          const id = pred.idValue ?? "";
          return {
            limit(): Promise<FakeRow[]> {
              const m = rows.find((r) => r.id === id);
              return Promise.resolve(m ? [m] : []);
            },
          };
        },
      };
    },
  });
  return { select } as unknown as Db;
}

// Monkey-patch the eq() reach — the route imports `eq` from drizzle-orm
// directly, and that returns an opaque SQL node. We can't introspect it
// from inside our fake. Workaround: use the upstream `eq` and have the
// fake builder ignore the predicate, returning every row. Because the
// tests always seed a single row, the lookup-by-id semantics still
// resolve correctly.
function makeDb(rows: FakeRow[]): Db {
  const select = (): unknown => ({
    from(): unknown {
      return {
        where(): unknown {
          return {
            limit(): Promise<FakeRow[]> {
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
  });
  return { select } as unknown as Db;
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nexus-audio-route-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("handleNotificationAudio", () => {
  it("returns 400 on invalid id (path traversal)", async () => {
    const db = makeDb([]);
    const req = new Request("http://localhost/notifications/..%2F..%2F/audio");
    const res = await handleNotificationAudio(db, "../../etc/passwd", req);
    expect(res.status).toBe(400);
  });

  it("returns 404 when no row exists", async () => {
    const db = makeDb([]);
    const req = new Request("http://localhost/notifications/n-missing/audio");
    const res = await handleNotificationAudio(db, "n-missing", req);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the row has NULL audio_path", async () => {
    const db = makeDb([{ id: "n-1", audioPath: null }]);
    const req = new Request("http://localhost/notifications/n-1/audio");
    const res = await handleNotificationAudio(db, "n-1", req);
    expect(res.status).toBe(404);
  });

  it("returns 410 when audio_path points at a missing file", async () => {
    const db = makeDb([{ id: "n-2", audioPath: join(tmp, "gone.mp3") }]);
    const req = new Request("http://localhost/notifications/n-2/audio");
    const res = await handleNotificationAudio(db, "n-2", req);
    expect(res.status).toBe(410);
  });

  it("streams the full mp3 on 200 with audio/mpeg content type", async () => {
    const path = join(tmp, "ok.mp3");
    // Synthetic mp3-ish payload — content is opaque to the route.
    writeFileSync(path, Buffer.alloc(256, 0xaa));
    const db = makeDb([{ id: "n-3", audioPath: path }]);
    const req = new Request("http://localhost/notifications/n-3/audio");
    const res = await handleNotificationAudio(db, "n-3", req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("Content-Length")).toBe("256");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(256);
    expect(body[0]).toBe(0xaa);
  });

  it("honors Range header — 206 with Content-Range slice", async () => {
    const path = join(tmp, "range.mp3");
    writeFileSync(path, Buffer.alloc(1024, 0xbb));
    const db = makeDb([{ id: "n-4", audioPath: path }]);
    const req = new Request("http://localhost/notifications/n-4/audio", {
      headers: { range: "bytes=100-199" },
    });
    const res = await handleNotificationAudio(db, "n-4", req);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 100-199/1024");
    expect(res.headers.get("Content-Length")).toBe("100");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body[0]).toBe(0xbb);
  });
});
