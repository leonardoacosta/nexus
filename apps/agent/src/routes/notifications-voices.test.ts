/**
 * notifications-voices route tests.
 *
 * Spec: openspec/changes/notifications-overhaul (task 2.9)
 *
 * Covers: list, insert, update, delete, idempotent delete, SSE event
 * emission on PUT + DELETE. Uses an in-memory fake DB and a stub bus
 * recorder.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { Db } from "@nexus/db";
import {
  handleListVoices,
  handlePutVoice,
  handleDeleteVoice,
} from "./notifications-voices";
import { lifecycleBus } from "../services/lifecycle-bus";

interface VoiceRow {
  project: string;
  voiceId: string;
  updatedAt: Date;
}

/**
 * Minimal in-memory fake DB that implements the chained drizzle API
 * used by the voices route. Anything else throws.
 */
function makeFakeDb(initial: VoiceRow[] = []): Db {
  const rows: VoiceRow[] = [...initial];

  const select = (): unknown => ({
    from(): Promise<VoiceRow[]> {
      return Promise.resolve(rows);
    },
  });

  const insert = (): unknown => ({
    values(v: { project: string; voiceId: string; updatedAt: Date }) {
      return {
        onConflictDoUpdate(arg: {
          set: { voiceId: string; updatedAt: Date };
        }) {
          const existing = rows.find((r) => r.project === v.project);
          if (existing) {
            existing.voiceId = arg.set.voiceId;
            existing.updatedAt = arg.set.updatedAt;
          } else {
            rows.push({
              project: v.project,
              voiceId: v.voiceId,
              updatedAt: v.updatedAt,
            });
          }
          return Promise.resolve();
        },
      };
    },
  });

  const del = (): unknown => ({
    where(predicate: { _project?: string }) {
      // Predicate is an opaque drizzle node; for our fake we delete by
      // scanning the most-recent project tag stashed by `eq()` callers.
      // To keep the fake simple we honor a single-row delete by using
      // the embedded project sentinel set via `setNextDeleteProject`.
      const target = (fake as { _nextDeleteProject?: string })
        ._nextDeleteProject;
      if (target) {
        const idx = rows.findIndex((r) => r.project === target);
        if (idx >= 0) rows.splice(idx, 1);
        (fake as { _nextDeleteProject?: string })._nextDeleteProject = undefined;
      }
      return Promise.resolve();
    },
  });

  const fake = {
    select,
    insert,
    delete: del,
    _rows: rows,
    _nextDeleteProject: undefined as string | undefined,
  };
  return fake as unknown as Db;
}

// Helper: clear bus listeners between tests + record fires.
function recordBus(): { events: { project: string }[]; cleanup: () => void } {
  const events: { project: string }[] = [];
  const handler = (env: { event: string; payload: { project: string } }) => {
    if (env.event === "VoiceOverrideChanged") events.push(env.payload);
  };
  lifecycleBus.onAny(handler as never);
  return {
    events,
    cleanup: () => lifecycleBus.offAny(handler as never),
  };
}

describe("handleListVoices", () => {
  it("returns {} on empty", async () => {
    const db = makeFakeDb([]);
    const res = await handleListVoices(db);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("returns the full mapping", async () => {
    const db = makeFakeDb([
      { project: "nx", voiceId: "v-1", updatedAt: new Date() },
      { project: "oo", voiceId: "v-2", updatedAt: new Date() },
    ]);
    const res = await handleListVoices(db);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nx: "v-1", oo: "v-2" });
  });
});

describe("handlePutVoice", () => {
  let bus: ReturnType<typeof recordBus>;
  beforeEach(() => {
    bus = recordBus();
  });

  it("rejects invalid project slugs", async () => {
    const db = makeFakeDb();
    const res = await handlePutVoice(
      db,
      "bad slug!",
      new Request("http://x", {
        method: "PUT",
        body: JSON.stringify({ voice_id: "v" }),
      }),
    );
    expect(res.status).toBe(400);
    bus.cleanup();
  });

  it("rejects empty voice_id", async () => {
    const db = makeFakeDb();
    const res = await handlePutVoice(
      db,
      "nx",
      new Request("http://x", {
        method: "PUT",
        body: JSON.stringify({ voice_id: "" }),
      }),
    );
    expect(res.status).toBe(400);
    bus.cleanup();
  });

  it("inserts a new override and emits the bus event", async () => {
    const db = makeFakeDb();
    const res = await handlePutVoice(
      db,
      "nx",
      new Request("http://x", {
        method: "PUT",
        body: JSON.stringify({ voice_id: "voice-XYZ" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.project).toBe("nx");
    expect(body.voice_id).toBe("voice-XYZ");
    expect(bus.events).toEqual([{ project: "nx" }]);
    bus.cleanup();
  });

  it("updates an existing override (idempotent upsert)", async () => {
    const db = makeFakeDb([
      { project: "nx", voiceId: "old", updatedAt: new Date(0) },
    ]);
    const res = await handlePutVoice(
      db,
      "nx",
      new Request("http://x", {
        method: "PUT",
        body: JSON.stringify({ voice_id: "new" }),
      }),
    );
    expect(res.status).toBe(200);
    const internal = (db as unknown as { _rows: VoiceRow[] })._rows;
    expect(internal).toHaveLength(1);
    expect(internal[0]!.voiceId).toBe("new");
    expect(bus.events).toEqual([{ project: "nx" }]);
    bus.cleanup();
  });
});

describe("handleDeleteVoice", () => {
  let bus: ReturnType<typeof recordBus>;
  beforeEach(() => {
    bus = recordBus();
  });

  it("returns 204 + emits bus event when row exists", async () => {
    const db = makeFakeDb([
      { project: "nx", voiceId: "v-1", updatedAt: new Date() },
    ]);
    (db as unknown as { _nextDeleteProject?: string })._nextDeleteProject = "nx";
    const res = await handleDeleteVoice(db, "nx");
    expect(res.status).toBe(204);
    expect((db as unknown as { _rows: VoiceRow[] })._rows).toHaveLength(0);
    expect(bus.events).toEqual([{ project: "nx" }]);
    bus.cleanup();
  });

  it("is idempotent — 204 with bus event even when row absent", async () => {
    const db = makeFakeDb();
    const res = await handleDeleteVoice(db, "ghost");
    expect(res.status).toBe(204);
    // Idempotent semantics still fire the bus event — subscribers
    // expecting "the user just deleted this" do not need to know
    // whether the row pre-existed.
    expect(bus.events).toEqual([{ project: "ghost" }]);
    bus.cleanup();
  });

  it("rejects invalid project slugs", async () => {
    const db = makeFakeDb();
    const res = await handleDeleteVoice(db, "../etc/passwd");
    expect(res.status).toBe(400);
    bus.cleanup();
  });
});
