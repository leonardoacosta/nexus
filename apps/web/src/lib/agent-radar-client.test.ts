import { describe, expect, it } from "bun:test";

import {
  isUnhealthy,
  parseFleetException,
  parseFleetExceptions,
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

describe("parseFleetException — camelCase wire (no remap)", () => {
  it("maps a full entry unchanged", () => {
    expect(
      parseFleetException({
        repo: "nx",
        class: "in_progress_stale",
        count: 12,
        offenders: ["nx-aaa", "nx-bbb"],
      }),
    ).toEqual({
      repo: "nx",
      class: "in_progress_stale",
      count: 12,
      offenders: ["nx-aaa", "nx-bbb"],
    });
  });

  it("defaults count to offenders.length and drops non-string offenders", () => {
    expect(
      parseFleetException({ repo: "oo", class: "p0_open", offenders: ["a", 3, null] }),
    ).toEqual({ repo: "oo", class: "p0_open", count: 1, offenders: ["a"] });
  });

  it("rejects an unknown class or a missing repo", () => {
    expect(parseFleetException({ repo: "x", class: "bogus", count: 1 })).toBeNull();
    expect(parseFleetException({ class: "p1_open", count: 1 })).toBeNull();
    expect(parseFleetException(null)).toBeNull();
  });
});

describe("parseFleetExceptions — bare array, silent-when-clean", () => {
  it("returns [] for a clean fleet (the load-bearing silent signal)", () => {
    expect(parseFleetExceptions([])).toEqual([]);
  });

  it("fail-softs a non-array payload to []", () => {
    expect(parseFleetExceptions(null)).toEqual([]);
    expect(parseFleetExceptions({})).toEqual([]);
  });

  it("parses valid entries and drops invalid ones", () => {
    const out = parseFleetExceptions([
      { repo: "nx", class: "ready_head_stale", count: 4, offenders: ["nx-1"] },
      { repo: "x", class: "nope" }, // invalid class -> dropped
      { repo: "mv", class: "unarchived_changes", count: 2, offenders: ["slug-a"] },
    ]);
    expect(out.map((e) => e.repo)).toEqual(["nx", "mv"]);
  });
});
