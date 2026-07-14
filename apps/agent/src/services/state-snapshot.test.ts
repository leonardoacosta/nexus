/**
 * Tests for `services/state-snapshot.ts` (nx-veo5g.4).
 *
 * Covers:
 *   1. serialize -> deserialize round-trip across a simulated restart.
 *   2. Content-diff flush skip (no write when nothing changed) + force flush.
 *   3. Debounce cadence (periodic flusher writes at most once per interval).
 *   4. Non-fatal handling of missing / corrupt / version-mismatched snapshots.
 *   5. One misbehaving source never aborts a whole snapshot/restore cycle.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerSnapshotSource,
  restoreSnapshot,
  flushSnapshot,
  startStateSnapshot,
  snapshotFilePath,
  __resetSnapshotForTests,
  type SnapshotSource,
} from "./state-snapshot";

let dir: string;
let path: string;

beforeEach(() => {
  __resetSnapshotForTests();
  dir = mkdtempSync(join(tmpdir(), "nx-snap-"));
  path = join(dir, "state", "behavioral-state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A trivial Map-backed source for round-trip testing. */
function mapSource(map: Map<string, number>): SnapshotSource {
  return {
    serialize: () => [...map.entries()],
    deserialize: (data) => {
      map.clear();
      for (const [k, v] of data as [string, number][]) map.set(k, v);
    },
  };
}

describe("state-snapshot round-trip", () => {
  test("serialize -> deserialize restores state across a simulated restart", () => {
    // ── Process 1: mutate + flush ──
    const live = new Map<string, number>([["a", 1], ["b", 2]]);
    registerSnapshotSource("m", mapSource(live));
    expect(flushSnapshot(path)).toBe(true);
    expect(existsSync(path)).toBe(true);

    // ── Process 2: fresh registry, restore into an empty map ──
    __resetSnapshotForTests();
    const restored = new Map<string, number>();
    registerSnapshotSource("m", mapSource(restored));
    const count = restoreSnapshot(path);

    expect(count).toBe(1);
    expect([...restored.entries()]).toEqual([["a", 1], ["b", 2]]);
  });

  test("a source not registered at restore time is skipped, not an error", () => {
    const live = new Map<string, number>([["x", 9]]);
    registerSnapshotSource("present", mapSource(live));
    registerSnapshotSource("gone", mapSource(new Map([["y", 5]])));
    flushSnapshot(path);

    __resetSnapshotForTests();
    const restored = new Map<string, number>();
    registerSnapshotSource("present", mapSource(restored));
    // "gone" is absent from the registry now — restore ignores that key.
    expect(restoreSnapshot(path)).toBe(1);
    expect([...restored.entries()]).toEqual([["x", 9]]);
  });
});

describe("state-snapshot content-diff", () => {
  test("flush skips the write when nothing changed, force overrides", () => {
    const live = new Map<string, number>([["a", 1]]);
    registerSnapshotSource("m", mapSource(live));

    expect(flushSnapshot(path)).toBe(true); // first write
    expect(flushSnapshot(path)).toBe(false); // unchanged -> skipped

    live.set("b", 2);
    expect(flushSnapshot(path)).toBe(true); // changed -> written
    expect(flushSnapshot(path)).toBe(false); // unchanged again

    // force writes even when unchanged
    expect(flushSnapshot(path, true)).toBe(true);
  });
});

describe("state-snapshot debounce cadence", () => {
  test("periodic flusher writes at most once per interval", async () => {
    const live = new Map<string, number>([["a", 1]]);
    registerSnapshotSource("m", mapSource(live));

    const stop = startStateSnapshot({ intervalMs: 20, path });
    // Mutate rapidly; only the interval boundary should produce a write.
    live.set("b", 2);
    await new Promise((r) => setTimeout(r, 55));
    live.set("c", 3);
    stop(); // stop() forces a final flush

    const env = JSON.parse(readFileSync(path, "utf8")) as {
      sources: { m: [string, number][] };
    };
    // Final forced flush on stop() captured the latest mutation.
    expect(env.sources.m).toEqual([["a", 1], ["b", 2], ["c", 3]]);
  });
});

describe("state-snapshot non-fatal restore", () => {
  test("missing snapshot restores 0, no throw", () => {
    registerSnapshotSource("m", mapSource(new Map()));
    expect(restoreSnapshot(join(dir, "does-not-exist.json"))).toBe(0);
  });

  test("corrupt JSON restores 0, no throw", () => {
    writeFileSync(path.replace(/state\/.*/, "corrupt.json"), "{ not json");
    const p = join(dir, "corrupt.json");
    writeFileSync(p, "{ not valid json ]");
    registerSnapshotSource("m", mapSource(new Map()));
    expect(restoreSnapshot(p)).toBe(0);
  });

  test("version mismatch is ignored", () => {
    const p = join(dir, "v99.json");
    writeFileSync(p, JSON.stringify({ version: 99, savedAt: "x", sources: { m: [["a", 1]] } }));
    const restored = new Map<string, number>();
    registerSnapshotSource("m", mapSource(restored));
    expect(restoreSnapshot(p)).toBe(0);
    expect(restored.size).toBe(0);
  });

  test("a source whose deserialize throws is skipped; siblings still restore", () => {
    const good = new Map<string, number>();
    registerSnapshotSource("good", mapSource(new Map([["a", 1]])));
    registerSnapshotSource("bad", {
      serialize: () => ({ some: "state" }),
      deserialize: () => {
        throw new Error("boom");
      },
    });
    flushSnapshot(path);

    __resetSnapshotForTests();
    registerSnapshotSource("good", mapSource(good));
    registerSnapshotSource("bad", {
      serialize: () => ({}),
      deserialize: () => {
        throw new Error("boom");
      },
    });
    // "good" restores (1), "bad" throws and is skipped.
    expect(restoreSnapshot(path)).toBe(1);
    expect([...good.entries()]).toEqual([["a", 1]]);
  });

  test("a source whose serialize throws does not abort the flush", () => {
    registerSnapshotSource("ok", mapSource(new Map([["a", 1]])));
    registerSnapshotSource("explodes", {
      serialize: () => {
        throw new Error("nope");
      },
      deserialize: () => {},
    });
    expect(flushSnapshot(path)).toBe(true);
    const env = JSON.parse(readFileSync(path, "utf8")) as { sources: Record<string, unknown> };
    expect(env.sources.ok).toEqual([["a", 1]]);
    expect("explodes" in env.sources).toBe(false);
  });
});

describe("snapshotFilePath", () => {
  test("honors NEXUS_CONFIG_DIR", () => {
    const prev = process.env.NEXUS_CONFIG_DIR;
    process.env.NEXUS_CONFIG_DIR = "/tmp/nx-cfg-test";
    try {
      expect(snapshotFilePath()).toBe("/tmp/nx-cfg-test/state/behavioral-state.json");
    } finally {
      if (prev === undefined) delete process.env.NEXUS_CONFIG_DIR;
      else process.env.NEXUS_CONFIG_DIR = prev;
    }
  });
});
