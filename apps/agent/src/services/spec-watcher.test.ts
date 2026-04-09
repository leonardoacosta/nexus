import { describe, test, expect, beforeEach } from "bun:test";
import { parseSpecList, processProjectSpecs, _projectState } from "./spec-watcher";

beforeEach(() => {
  // Clear the module-level state between tests.
  _projectState.clear();
});

// ---------------------------------------------------------------------------
// parseSpecList
// ---------------------------------------------------------------------------

describe("parseSpecList", () => {
  test("valid JSON with spec objects returns SpecSnapshot[]", () => {
    const input = JSON.stringify([
      {
        name: "add-feature",
        status: "active",
        completedTasks: 3,
        totalTasks: 10,
        lastModified: "2026-04-01T12:00:00Z",
      },
      {
        name: "fix-bug",
        status: "applied",
        completedTasks: 5,
        totalTasks: 5,
      },
    ]);

    const result = parseSpecList(input);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("add-feature");
    expect(result[0]!.status).toBe("active");
    expect(result[0]!.completedTasks).toBe(3);
    expect(result[0]!.totalTasks).toBe(10);
    expect(result[0]!.lastModified).toBe("2026-04-01T12:00:00Z");
    expect(result[1]!.name).toBe("fix-bug");
    expect(result[1]!.completedTasks).toBe(5);
  });

  test("invalid JSON returns empty array", () => {
    expect(parseSpecList("not json at all")).toEqual([]);
    expect(parseSpecList("{broken")).toEqual([]);
    expect(parseSpecList("")).toEqual([]);
  });

  test("non-array JSON returns empty array", () => {
    expect(parseSpecList(JSON.stringify({ name: "foo" }))).toEqual([]);
    expect(parseSpecList(JSON.stringify("just a string"))).toEqual([]);
  });

  test("missing fields use defaults", () => {
    const input = JSON.stringify([
      { name: "minimal-spec" },
    ]);

    const result = parseSpecList(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("minimal-spec");
    expect(result[0]!.status).toBe("unknown");
    expect(result[0]!.completedTasks).toBe(0);
    expect(result[0]!.totalTasks).toBe(0);
    expect(result[0]!.lastModified).toBeUndefined();
  });

  test("handles snake_case keys", () => {
    const input = JSON.stringify([
      {
        name: "snake-spec",
        status: "draft",
        completed_tasks: 2,
        total_tasks: 8,
        last_modified: "2026-03-15T08:00:00Z",
      },
    ]);

    const result = parseSpecList(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.completedTasks).toBe(2);
    expect(result[0]!.totalTasks).toBe(8);
    expect(result[0]!.lastModified).toBe("2026-03-15T08:00:00Z");
  });

  test("entries without a name are skipped", () => {
    const input = JSON.stringify([
      { status: "active", completedTasks: 1 },
      { name: "has-name", status: "active" },
      { name: "", status: "draft" },
    ]);

    const result = parseSpecList(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("has-name");
  });
});

// ---------------------------------------------------------------------------
// processProjectSpecs (change detection / "detectTransitions")
// ---------------------------------------------------------------------------

describe("processProjectSpecs (detectTransitions)", () => {
  const PROJECT = "test-proj";
  // Use a non-existent cwd so readProposalHash always returns null.
  const CWD = "/tmp/nexus-test-nonexistent-cwd";

  test("new spec appears emits NewSpec event", () => {
    // First tick: seed state silently.
    const seedEvents = processProjectSpecs(PROJECT, CWD, [], true);
    expect(seedEvents).toHaveLength(0);

    // Second tick: new spec appears.
    const events = processProjectSpecs(
      PROJECT,
      CWD,
      [{ name: "add-feature", status: "active", completedTasks: 0, totalTasks: 5 }],
      false,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("new_spec");
    expect(events[0]!).toHaveProperty("name", "add-feature");
  });

  test("spec disappears emits Removed event", () => {
    // Seed with one spec.
    processProjectSpecs(
      PROJECT,
      CWD,
      [{ name: "old-spec", status: "active", completedTasks: 0, totalTasks: 3 }],
      true,
    );

    // Next tick: spec is gone.
    const events = processProjectSpecs(PROJECT, CWD, [], false);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("removed");
    expect(events[0]!).toHaveProperty("name", "old-spec");
  });

  test("progress change emits Progress event", () => {
    // Seed with initial progress.
    processProjectSpecs(
      PROJECT,
      CWD,
      [{ name: "prog-spec", status: "active", completedTasks: 2, totalTasks: 10 }],
      true,
    );

    // Next tick: completedTasks increases.
    const events = processProjectSpecs(
      PROJECT,
      CWD,
      [{ name: "prog-spec", status: "active", completedTasks: 5, totalTasks: 10 }],
      false,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("progress");
    const progressEvent = events[0] as { type: "progress"; completed: number; total: number };
    expect(progressEvent.completed).toBe(5);
    expect(progressEvent.total).toBe(10);
  });

  test("all tasks complete emits AllComplete event", () => {
    // Seed with incomplete spec.
    processProjectSpecs(
      PROJECT,
      CWD,
      [{ name: "done-spec", status: "active", completedTasks: 4, totalTasks: 5 }],
      true,
    );

    // Next tick: all tasks done.
    const events = processProjectSpecs(
      PROJECT,
      CWD,
      [{ name: "done-spec", status: "active", completedTasks: 5, totalTasks: 5 }],
      false,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("all_complete");
  });

  test("no events on first tick (initial state population)", () => {
    const events = processProjectSpecs(
      PROJECT,
      CWD,
      [
        { name: "spec-a", status: "active", completedTasks: 1, totalTasks: 3 },
        { name: "spec-b", status: "draft", completedTasks: 0, totalTasks: 0 },
      ],
      true,
    );

    expect(events).toHaveLength(0);
  });

  test("no change emits no events", () => {
    const specs = [
      { name: "stable-spec", status: "active", completedTasks: 3, totalTasks: 5 },
    ];

    // Seed.
    processProjectSpecs(PROJECT, CWD, specs, true);
    // Same data, no change.
    const events = processProjectSpecs(PROJECT, CWD, specs, false);

    expect(events).toHaveLength(0);
  });

  test("multiple transitions in one tick", () => {
    // Seed with two specs.
    processProjectSpecs(
      PROJECT,
      CWD,
      [
        { name: "spec-keep", status: "active", completedTasks: 1, totalTasks: 5 },
        { name: "spec-remove", status: "draft", completedTasks: 0, totalTasks: 3 },
      ],
      true,
    );

    // Next tick: one removed, one progressed, one new.
    const events = processProjectSpecs(
      PROJECT,
      CWD,
      [
        { name: "spec-keep", status: "active", completedTasks: 3, totalTasks: 5 },
        { name: "spec-new", status: "active", completedTasks: 0, totalTasks: 2 },
      ],
      false,
    );

    const types = events.map((e) => e.type).sort();
    expect(types).toContain("progress");
    expect(types).toContain("new_spec");
    expect(types).toContain("removed");
    expect(events).toHaveLength(3);
  });
});
