/**
 * Parser purity contract tests.
 *
 * All assertions are made without any child_process mock — if a mock were
 * required it would indicate the parser has acquired a side-effect and the
 * purity contract is broken.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { parseSpecList, processProjectSpecs, type TrackedSpec } from "./parser";

// ---------------------------------------------------------------------------
// parseSpecList
// ---------------------------------------------------------------------------

describe("parseSpecList", () => {
  test("camelCase fields parse correctly", () => {
    const input = JSON.stringify([
      {
        name: "auth-overhaul",
        status: "active",
        completedTasks: 4,
        totalTasks: 12,
        lastModified: "2026-04-10T09:00:00Z",
      },
    ]);
    const result = parseSpecList(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("auth-overhaul");
    expect(result[0]!.status).toBe("active");
    expect(result[0]!.completedTasks).toBe(4);
    expect(result[0]!.totalTasks).toBe(12);
    expect(result[0]!.lastModified).toBe("2026-04-10T09:00:00Z");
  });

  test("snake_case fields are normalised", () => {
    const input = JSON.stringify([
      { name: "snake-spec", completed_tasks: 2, total_tasks: 6, last_modified: "2026-03-01T00:00:00Z" },
    ]);
    const result = parseSpecList(input);
    expect(result[0]!.completedTasks).toBe(2);
    expect(result[0]!.totalTasks).toBe(6);
    expect(result[0]!.lastModified).toBe("2026-03-01T00:00:00Z");
  });

  test("missing optional fields use defaults", () => {
    const result = parseSpecList(JSON.stringify([{ name: "bare-spec" }]));
    expect(result[0]!.status).toBe("unknown");
    expect(result[0]!.completedTasks).toBe(0);
    expect(result[0]!.totalTasks).toBe(0);
    expect(result[0]!.lastModified).toBeUndefined();
  });

  test("invalid / non-array JSON returns empty array", () => {
    expect(parseSpecList("not-json")).toEqual([]);
    expect(parseSpecList(JSON.stringify({ name: "obj" }))).toEqual([]);
    expect(parseSpecList("")).toEqual([]);
  });

  test("entries without a name are skipped", () => {
    const input = JSON.stringify([
      { status: "active" },
      { name: "", status: "draft" },
      { name: "valid-spec" },
    ]);
    const result = parseSpecList(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("valid-spec");
  });
});

// ---------------------------------------------------------------------------
// processProjectSpecs — purity & diff correctness
// ---------------------------------------------------------------------------

describe("processProjectSpecs", () => {
  // Each test owns its own projectState — no shared module state.
  let state: Map<string, Map<string, TrackedSpec>>;
  const PROJECT = "purity-proj";
  // Non-existent path so readProposalHash always returns null (no fs fixture needed).
  const CWD = "/tmp/nexus-parser-test-nonexistent";

  beforeEach(() => {
    state = new Map();
  });

  test("first tick populates state silently (no events emitted)", () => {
    const events = processProjectSpecs(
      PROJECT,
      CWD,
      [{ name: "spec-a", status: "active", completedTasks: 1, totalTasks: 5 }],
      true,
      state,
    );
    expect(events).toHaveLength(0);
  });

  test("new spec on second tick emits new_spec event", () => {
    // Seed with empty list.
    processProjectSpecs(PROJECT, CWD, [], true, state);

    const events = processProjectSpecs(
      PROJECT,
      CWD,
      [{ name: "fresh-spec", status: "active", completedTasks: 0, totalTasks: 3 }],
      false,
      state,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("new_spec");
    expect(events[0]!).toHaveProperty("name", "fresh-spec");
    expect(events[0]!).toHaveProperty("project", PROJECT);
  });

  test("spec disappears emits removed event", () => {
    processProjectSpecs(
      PROJECT,
      CWD,
      [{ name: "dying-spec", status: "active", completedTasks: 0, totalTasks: 3 }],
      true,
      state,
    );

    const events = processProjectSpecs(PROJECT, CWD, [], false, state);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("removed");
    expect(events[0]!).toHaveProperty("name", "dying-spec");
  });

  test("progress increase emits progress event", () => {
    processProjectSpecs(
      PROJECT,
      CWD,
      [{ name: "wip-spec", status: "active", completedTasks: 2, totalTasks: 10 }],
      true,
      state,
    );

    const events = processProjectSpecs(
      PROJECT,
      CWD,
      [{ name: "wip-spec", status: "active", completedTasks: 6, totalTasks: 10 }],
      false,
      state,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("progress");
    const ev = events[0] as { type: "progress"; completed: number; total: number };
    expect(ev.completed).toBe(6);
    expect(ev.total).toBe(10);
  });

  test("final task completion emits all_complete (not progress)", () => {
    processProjectSpecs(
      PROJECT,
      CWD,
      [{ name: "almost-done", status: "active", completedTasks: 4, totalTasks: 5 }],
      true,
      state,
    );

    const events = processProjectSpecs(
      PROJECT,
      CWD,
      [{ name: "almost-done", status: "active", completedTasks: 5, totalTasks: 5 }],
      false,
      state,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("all_complete");
  });

  test("no change emits no events", () => {
    const specs = [{ name: "stable", status: "active", completedTasks: 3, totalTasks: 7 }];
    processProjectSpecs(PROJECT, CWD, specs, true, state);
    const events = processProjectSpecs(PROJECT, CWD, specs, false, state);
    expect(events).toHaveLength(0);
  });

  test("multiple simultaneous transitions are all emitted", () => {
    processProjectSpecs(
      PROJECT,
      CWD,
      [
        { name: "keep-spec", status: "active", completedTasks: 1, totalTasks: 5 },
        { name: "drop-spec", status: "active", completedTasks: 0, totalTasks: 2 },
      ],
      true,
      state,
    );

    const events = processProjectSpecs(
      PROJECT,
      CWD,
      [
        { name: "keep-spec", status: "active", completedTasks: 3, totalTasks: 5 },
        { name: "brand-new", status: "draft", completedTasks: 0, totalTasks: 1 },
      ],
      false,
      state,
    );

    const types = events.map((e) => e.type).sort();
    expect(types).toContain("progress");
    expect(types).toContain("removed");
    expect(types).toContain("new_spec");
    expect(events).toHaveLength(3);
  });
});
