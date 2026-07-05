/**
 * Radar hide/show persistence + partition tests (task 3.2).
 *
 * Covers the two assertions not exercised by the pure parse layer in
 * `agent-radar-client.test.ts`:
 *   - healthy + degraded rows partition correctly from a stubbed SourceIndex
 *     (which rows render, degraded summary count);
 *   - the per-source hide toggle survives a reload via localStorage.
 *
 * bun test has no DOM, so we install a minimal in-memory `window.localStorage`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { parseSourceIndex } from "~/lib/agent-radar-client";
import {
  HIDDEN_KEY,
  loadHidden,
  partitionSources,
  persistHidden,
} from "./radar-hidden";

// ── Minimal in-memory localStorage / window stub ───────────────────────────
function installStorage(): void {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  (globalThis as { window?: unknown }).window = { localStorage };
}

beforeEach(installStorage);
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

// A stubbed gateway SourceIndex: one healthy (SERVING), one degraded.
const STUB_INDEX = parseSourceIndex({
  sources: [
    { id: "teams", display_name: "Teams", status: "serving", item_count: 40 },
    {
      id: "snow",
      display_name: "ServiceNow",
      status: "DEGRADED",
      reason: "token expires in 2d",
    },
  ],
});

describe("partitionSources — healthy + degraded rows", () => {
  it("renders both rows and counts the degraded one when nothing hidden", () => {
    const p = partitionSources(STUB_INDEX.sources, new Set());
    expect(p.visible.map((s) => s.id)).toEqual(["teams", "snow"]);
    expect(p.degradedCount).toBe(1); // snow is DEGRADED
    expect(p.hiddenCount).toBe(0);
  });

  it("excludes a hidden source from rows but still counts it as degraded", () => {
    const p = partitionSources(STUB_INDEX.sources, new Set(["snow"]));
    expect(p.visible.map((s) => s.id)).toEqual(["teams"]);
    expect(p.hiddenSources.map((s) => s.id)).toEqual(["snow"]);
    expect(p.hiddenCount).toBe(1);
    // degraded count is over the WHOLE set — hiding must not drop it from the summary
    expect(p.degradedCount).toBe(1);
  });
});

describe("hide toggle persistence (survives reload)", () => {
  it("defaults to an empty set with nothing stored", () => {
    expect(loadHidden().size).toBe(0);
  });

  it("persistHidden -> loadHidden round-trips the id set across a 'reload'", () => {
    persistHidden(new Set(["snow", "gmail"]));
    // A fresh load (simulating a page reload) sees the persisted ids.
    const reloaded = loadHidden();
    expect([...reloaded].sort()).toEqual(["gmail", "snow"]);
  });

  it("tolerates malformed localStorage content", () => {
    window.localStorage.setItem(HIDDEN_KEY, "{not json");
    expect(loadHidden().size).toBe(0);
  });

  it("ignores non-string entries in a stored array", () => {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(["snow", 3, null]));
    expect([...loadHidden()]).toEqual(["snow"]);
  });
});
