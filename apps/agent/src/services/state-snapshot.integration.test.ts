/**
 * Integration-style test for behavioral state snapshot/restore (nx-veo5g.4).
 *
 * Proves a REAL service's state (the notification dedup window) survives a
 * simulated agent restart: populate the live `dedupMap` through the module's
 * own `isDuplicate`, flush to disk, wipe the map (as a crash-restart would),
 * restore from disk, and confirm the previously-seen triple is still deduped.
 *
 * Unlike state-snapshot.test.ts (which registers throwaway sources), this test
 * exercises the ACTUAL `registerSnapshotSource("notification-dedup", …)` wired
 * into routes/notifications.ts — so it verifies the real serialize/deserialize
 * pair, not a stand-in.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Importing this module registers the real "notification-dedup" snapshot source.
import { _testDedupInternals } from "../routes/notifications";
import { flushSnapshot, restoreSnapshot } from "./state-snapshot";

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  // Leave the shared registry intact (it holds the real service sources); only
  // clear the live map so the next case starts clean.
  _testDedupInternals.map.clear();
});

describe("notification dedup survives a simulated restart", () => {
  test("a triple seen before restart is still deduped after restore", () => {
    dir = mkdtempSync(join(tmpdir(), "nx-snap-int-"));
    const path = join(dir, "behavioral-state.json");

    const { isDuplicate, map } = _testDedupInternals;
    map.clear();

    // ── Before restart: first sighting is NOT a dup, it arms the window. ──
    expect(isDuplicate("build failed", "nexus", "tts")).toBe(false);
    // Second sighting within the window IS a dup (baseline behavior).
    expect(isDuplicate("build failed", "nexus", "tts")).toBe(true);
    expect(map.size).toBe(1);

    // Persist the live state.
    expect(flushSnapshot(path)).toBe(true);

    // ── Simulate a crash-restart: memory is wiped. ──
    map.clear();
    expect(map.size).toBe(0);
    // Without restore, the same triple would be treated as brand-new and the
    // notification would re-fire — that's exactly the bug Layer D closes.

    // ── Restore from disk. ──
    const restored = restoreSnapshot(path);
    expect(restored).toBeGreaterThanOrEqual(1);
    expect(map.size).toBe(1);

    // The previously-seen triple is STILL suppressed after the "restart".
    expect(isDuplicate("build failed", "nexus", "tts")).toBe(true);

    // A genuinely new triple is not suppressed.
    expect(isDuplicate("tests passed", "nexus", "tts")).toBe(false);
  });

  test("expired dedup entries are not resurrected on restore", () => {
    dir = mkdtempSync(join(tmpdir(), "nx-snap-int-"));
    const path = join(dir, "behavioral-state.json");

    const { map } = _testDedupInternals;
    map.clear();
    // Insert an already-expired entry directly (expiry in the past).
    map.set("stale-key", Date.now() - 1);
    // Insert a live entry.
    map.set("live-key", Date.now() + 60_000);

    flushSnapshot(path);
    map.clear();
    restoreSnapshot(path);

    // Only the live entry comes back — the expired one carried no value.
    expect(map.has("live-key")).toBe(true);
    expect(map.has("stale-key")).toBe(false);
  });
});
