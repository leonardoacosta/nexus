/**
 * Unit tests for the pane-translation helper (reconcile-session-id-universes,
 * task 3.1).
 *
 * `parsePaneTranslationOutput` is pure and synchronous — no subprocess, no
 * I/O — so it is tested directly with hand-built raw `tmux list-panes -a`
 * stdout fixtures, mirroring `process-watcher.test.ts`'s convention for
 * testing this codebase's other tmux-output parsers (fixtures as plain
 * strings, no mocking needed for the pure function itself).
 *
 * `fetchPaneTranslationMap` additionally exercises the fail-soft shell-out
 * wrapper via the shared, RESTORABLE `../testing/mock-exec` helper (the same
 * `installExecMock` pattern `process-watcher.test.ts` uses to stub
 * `execText`) — confirming a thrown subprocess error degrades to an empty
 * map rather than propagating.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { installExecMock, type ExecMockHandle } from "../../testing/mock-exec";
import {
  parsePaneTranslationOutput,
  fetchPaneTranslationMap,
} from "./pane-translation";

// ── parsePaneTranslationOutput — pure parser ───────────────────────────────

describe("parsePaneTranslationOutput", () => {
  test("well-formed multi-line output parses into the correct map", () => {
    const raw = ["%0|main:0.0", "%1|main:0.1", "%2|work:1.0"].join("\n");

    const map = parsePaneTranslationOutput(raw);

    expect(map.size).toBe(3);
    expect(map.get("%0")).toBe("main:0.0");
    expect(map.get("%1")).toBe("main:0.1");
    expect(map.get("%2")).toBe("work:1.0");
  });

  test("a line missing the '|' separator is skipped; other well-formed lines still parse", () => {
    const raw = ["%0|main:0.0", "this-line-has-no-separator", "%1|main:0.1"].join(
      "\n",
    );

    const map = parsePaneTranslationOutput(raw);

    expect(map.size).toBe(2);
    expect(map.get("%0")).toBe("main:0.0");
    expect(map.get("%1")).toBe("main:0.1");
  });

  test("a line with a blank pane-id (leading '|') is skipped", () => {
    const raw = ["|main:0.0", "%1|main:0.1"].join("\n");

    const map = parsePaneTranslationOutput(raw);

    expect(map.size).toBe(1);
    expect(map.get("%1")).toBe("main:0.1");
    expect(map.has("")).toBe(false);
  });

  test("a line with a blank address (trailing '|') is skipped", () => {
    const raw = ["%0|", "%1|main:0.1"].join("\n");

    const map = parsePaneTranslationOutput(raw);

    expect(map.size).toBe(1);
    expect(map.get("%1")).toBe("main:0.1");
    expect(map.has("%0")).toBe(false);
  });

  test("blank lines (including surrounding whitespace) are skipped, not thrown on", () => {
    const raw = ["%0|main:0.0", "", "   ", "%1|main:0.1"].join("\n");

    const map = parsePaneTranslationOutput(raw);

    expect(map.size).toBe(2);
    expect(map.get("%0")).toBe("main:0.0");
    expect(map.get("%1")).toBe("main:0.1");
  });

  test("empty input string returns an empty map", () => {
    const map = parsePaneTranslationOutput("");
    expect(map.size).toBe(0);
  });

  test("whitespace-only input string returns an empty map", () => {
    const map = parsePaneTranslationOutput("   \n  \n");
    expect(map.size).toBe(0);
  });
});

// ── fetchPaneTranslationMap — fail-soft shell-out wrapper ──────────────────

describe("fetchPaneTranslationMap", () => {
  let execHandle: ExecMockHandle | undefined;

  afterEach(() => {
    execHandle?.restore();
    execHandle = undefined;
  });

  test("translates real tmux list-panes stdout into the expected map", async () => {
    execHandle = installExecMock({
      execText: async () => "%3|main:2.0\n%4|main:2.1",
      execJson: async () => null,
    });

    const map = await fetchPaneTranslationMap();

    expect(map.size).toBe(2);
    expect(map.get("%3")).toBe("main:2.0");
    expect(map.get("%4")).toBe("main:2.1");
  });

  test("a thrown subprocess error degrades to an empty map, never throws", async () => {
    execHandle = installExecMock({
      execText: async () => {
        throw new Error("tmux: no server running on /tmp/tmux-1000/default");
      },
      execJson: async () => null,
    });

    const map = await fetchPaneTranslationMap();

    expect(map.size).toBe(0);
  });
});
