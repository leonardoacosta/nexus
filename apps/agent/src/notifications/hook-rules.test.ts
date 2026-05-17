/**
 * Per-rule unit tests for `hook-rules.ts`. Each rule is a pure function over
 * the hook event payload — no DB, no manager, no lifecycle bus required. We
 * build fixture payloads, call the rule directly, and assert the returned
 * `NotificationDraft[]` shape (or `null` for failed predicates).
 */

import { describe, expect, it } from "bun:test";
import {
  hookRules,
  COST_DIGEST_THRESHOLD_USD,
  type NotificationDraft,
} from "./hook-rules";
import type { HookEventPayload } from "../routes/hooks";

function payload(overrides: Partial<HookEventPayload> = {}): HookEventPayload {
  return {
    session_id: "sess-test",
    project: "nx",
    ...overrides,
  };
}

function channels(drafts: NotificationDraft[] | null): string[] {
  return (drafts ?? []).map((d) => d.channel).sort();
}

describe("hook-rules registry", () => {
  it("exposes exactly the five canonical rules", () => {
    const keys = Object.keys(hookRules).sort();
    expect(keys).toEqual([
      "hook_failure",
      "permission_request",
      "session_stop",
      "session_summary",
      "tool_use_fail",
    ]);
  });
});

describe("tool_use_fail rule", () => {
  it("fires desktop with project-prefixed body", () => {
    const drafts = hookRules.tool_use_fail!(
      payload({ tool_name: "Bash", error_message: "permission denied" }),
    );
    expect(channels(drafts)).toEqual(["desktop"]);
    expect(drafts).not.toBeNull();
    for (const d of drafts!) {
      expect(d.title).toContain("Bash");
      expect(d.body.startsWith("nx: ")).toBe(true);
      expect(d.body).toContain("permission denied");
      expect(d.project).toBe("nx");
    }
  });

  it("falls back to Wave 1 alias names (`tool`, `error`)", () => {
    const drafts = hookRules.tool_use_fail!(
      payload({ tool: "Edit", error: "EACCES" }),
    );
    expect(drafts).not.toBeNull();
    expect(drafts![0]!.title).toContain("Edit");
    expect(drafts![0]!.body).toContain("EACCES");
  });

  it("omits project prefix when payload has no project", () => {
    const drafts = hookRules.tool_use_fail!(
      payload({ project: undefined, tool_name: "Bash", error_message: "boom" }),
    );
    expect(drafts).not.toBeNull();
    expect(drafts![0]!.body.startsWith("Bash")).toBe(true);
    expect(drafts![0]!.project).toBeNull();
  });
});

describe("permission_request rule", () => {
  it("fires desktop + tts always", () => {
    const drafts = hookRules.permission_request!(
      payload({ tool_name: "Edit" }),
    );
    expect(channels(drafts)).toEqual(["desktop", "tts"]);
    for (const d of drafts!) {
      expect(d.body).toContain("Edit");
      expect(d.body.startsWith("nx: ")).toBe(true);
    }
  });
});

describe("hook_failure rule", () => {
  it("fires desktop", () => {
    const drafts = hookRules.hook_failure!(
      payload({ hook_name: "post_compact", error_message: "jq write failed" }),
    );
    expect(channels(drafts)).toEqual(["desktop"]);
    expect(drafts![0]!.title).toContain("post_compact");
    expect(drafts![0]!.body).toContain("jq write failed");
  });

  it("falls back to Wave 1 `handler` field", () => {
    const drafts = hookRules.hook_failure!(
      payload({ handler: "session_stop", error: "boom" }),
    );
    expect(drafts).not.toBeNull();
    expect(drafts![0]!.title).toContain("session_stop");
  });
});

describe("session_stop rule", () => {
  it("fires desktop when crash_flag === true", () => {
    const drafts = hookRules.session_stop!(payload({ crash_flag: true }));
    expect(channels(drafts)).toEqual(["desktop"]);
  });

  it("fires desktop when stop_reason indicates a crash", () => {
    const drafts = hookRules.session_stop!(payload({ stop_reason: "oom" }));
    expect(channels(drafts)).toEqual(["desktop"]);
    expect(drafts![0]!.body).toContain("oom");
  });

  it("returns null when crash_flag is false and stop_reason is benign", () => {
    expect(hookRules.session_stop!(payload({ crash_flag: false }))).toBeNull();
    expect(hookRules.session_stop!(payload({ stop_reason: "user" }))).toBeNull();
    expect(hookRules.session_stop!(payload({}))).toBeNull();
  });
});

describe("session_summary rule", () => {
  it("fires desktop digest when cost_usd >= threshold", () => {
    const drafts = hookRules.session_summary!(
      payload({ cost_usd: COST_DIGEST_THRESHOLD_USD }),
    );
    expect(channels(drafts)).toEqual(["desktop"]);
    expect(drafts![0]!.body).toContain("0.50");
  });

  it("formats cost to 2 decimals", () => {
    const drafts = hookRules.session_summary!(payload({ cost_usd: 2.345 }));
    expect(drafts![0]!.body).toContain("$2.35");
  });

  it("returns null when cost_usd is below the threshold", () => {
    expect(
      hookRules.session_summary!(payload({ cost_usd: 0.12 })),
    ).toBeNull();
  });

  it("returns null when cost_usd is missing", () => {
    expect(hookRules.session_summary!(payload({}))).toBeNull();
  });
});
