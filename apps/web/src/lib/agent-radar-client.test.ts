import { describe, expect, it } from "bun:test";

import {
  isUnhealthy,
  parseSource,
  parseSourceIndex,
  parseTransitions,
} from "./agent-radar-client";

describe("parseSource — snake_case wire -> camelCase DTO", () => {
  it("maps every field and normalizes health", () => {
    const s = parseSource({
      id: "teams",
      display_name: "Teams",
      produces_kind: "CHAT_MESSAGE",
      in_aggregate: true,
      status: "serving",
      reason: "",
      last_sync_at: "2026-07-05T10:00:00Z",
      item_count: 42,
      mine_count: 6,
      can_search: true,
      can_stream: true,
    });
    expect(s).toEqual({
      id: "teams",
      displayName: "Teams",
      producesKind: "CHAT_MESSAGE",
      inAggregate: true,
      health: "SERVING",
      healthReason: null,
      lastSyncAt: "2026-07-05T10:00:00Z",
      itemCount: 42,
      mineCount: 6,
      canSearch: true,
      canStream: true,
    });
  });

  it("falls back displayName->id, defaults, and UNKNOWN health", () => {
    const s = parseSource({ id: "snow", status: "bogus" });
    expect(s?.displayName).toBe("snow");
    expect(s?.health).toBe("UNKNOWN");
    expect(s?.inAggregate).toBe(true);
    expect(s?.itemCount).toBeNull();
    expect(s?.mineCount).toBe(0);
  });

  it("returns null without a usable id", () => {
    expect(parseSource({ display_name: "x" })).toBeNull();
    expect(parseSource(null)).toBeNull();
  });

  it("preserves a degraded reason and reports unhealthy", () => {
    const s = parseSource({
      id: "snow",
      status: "DEGRADED",
      reason: "credential degraded",
    });
    expect(s?.health).toBe("DEGRADED");
    expect(s?.healthReason).toBe("credential degraded");
    expect(isUnhealthy(s!.health)).toBe(true);
  });
});

describe("parseSourceIndex", () => {
  it("filters invalid rows and tolerates a missing sources key", () => {
    const idx = parseSourceIndex({ sources: [{ id: "a" }, { nope: 1 }] });
    expect(idx.sources.map((s) => s.id)).toEqual(["a"]);
    expect(parseSourceIndex({}).sources).toEqual([]);
    expect(parseSourceIndex(null).sources).toEqual([]);
  });
});

describe("parseTransitions", () => {
  it("maps transition rows tolerantly and synthesizes ids", () => {
    const rows = parseTransitions({
      requests: [
        {
          title: "Sign off runbook",
          source: "teams",
          field: "disposition",
          old_value: "OPEN",
          new_value: "MINE",
          changed_at: "2026-07-05T09:00:00Z",
        },
        { from: "A", to: "B" }, // alternate spelling, no id/title
      ],
    });
    expect(rows[0]).toEqual({
      id: "0",
      title: "Sign off runbook",
      source: "teams",
      field: "disposition",
      oldValue: "OPEN",
      newValue: "MINE",
      changedAt: "2026-07-05T09:00:00Z",
    });
    expect(rows[1]?.oldValue).toBe("A");
    expect(rows[1]?.newValue).toBe("B");
    expect(rows[1]?.title).toBe("(untitled request)");
  });

  it("returns [] for the fail-soft empty feed", () => {
    expect(parseTransitions({ requests: [] })).toEqual([]);
    expect(parseTransitions({})).toEqual([]);
    expect(parseTransitions(null)).toEqual([]);
  });
});
