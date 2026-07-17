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
import type { HookEventPayload } from "../routes/hooks-types";

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
  it("exposes exactly the four canonical rules", () => {
    const keys = Object.keys(hookRules).sort();
    // remove-tool-use-fail-notification (nx-l08rs): `tool_use_fail` was
    // removed from the registry — it fired a desktop banner on every failed
    // tool call, throttled but never eliminated (112 banners/48h).
    // drop-permission-request-tts-draft (nx-okdvj, 2026-07-16):
    // `permission_request` was removed too — the agent-side desktop+tts
    // drafts double/triple-pushed alongside cc telemetry.sh's rich
    // `nx_notify` banner. Four entries is asserted exactly — a fifth is a
    // deliberate change requiring a spec update.
    expect(keys).toEqual([
      "api_error",
      "hook_failure",
      "session_stop",
      "session_summary",
    ]);
    expect(keys).toHaveLength(4);
  });

  it("no longer maps tool_use_fail to a rule (nx-l08rs)", () => {
    expect(hookRules.tool_use_fail).toBeUndefined();
  });

  // drop-permission-request-tts-draft (nx-okdvj): permission_request no
  // longer maps to a rule — there is nothing left to call, so the dispatch
  // entrypoint (`evaluateAndDispatch` in hook-trigger.ts) hits its existing
  // "event type has no notification rule" no-op branch and produces zero
  // drafts. See hook-trigger.test.ts for the dispatch-level assertion.
  it("no longer maps permission_request to a rule (nx-okdvj)", () => {
    expect(hookRules.permission_request).toBeUndefined();
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

  it("includes the captured error text in the body for api_error (nx-f060f)", () => {
    const drafts = hookRules.session_stop!(
      payload({
        stop_reason: "api_error",
        error_details: "API Error: 529 Overloaded",
        crash_flag: true,
      }),
    );
    expect(channels(drafts)).toEqual(["desktop"]);
    // Per-reason classified body carries the verbatim error text.
    expect(drafts![0]!.body).toContain("API Error: 529 Overloaded");
    expect(drafts![0]!.body).toContain("api_error");
    // Title is specialized for the api_error reason.
    expect(drafts![0]!.title).toContain("api error");
  });

  it("falls back to the generic body when error_details is absent", () => {
    const drafts = hookRules.session_stop!(payload({ stop_reason: "crash" }));
    expect(drafts![0]!.body).toContain("session stopped with crash");
  });

  // add-api-error-notification (nx-nsjif): sessionStopRule ceded `api_error` to
  // apiErrorRule. A bare api_error stop (no crash_flag) must NOT fire here.
  it("no longer fires for stop_reason api_error (ceded to apiErrorRule)", () => {
    expect(
      hookRules.session_stop!(payload({ stop_reason: "api_error" })),
    ).toBeNull();
  });

  // ...but it still owns the other crash reasons. oom is the canonical retained
  // case (nx-nsjif).
  it("still fires for stop_reason oom", () => {
    const drafts = hookRules.session_stop!(payload({ stop_reason: "oom" }));
    expect(channels(drafts)).toEqual(["desktop"]);
    expect(drafts![0]!.body).toContain("oom");
  });

  it("still fires for stop_reason error, crash, timeout", () => {
    for (const reason of ["error", "crash", "timeout"]) {
      const drafts = hookRules.session_stop!(payload({ stop_reason: reason }));
      expect(channels(drafts)).toEqual(["desktop"]);
    }
  });
});

// ─── api_error rule (add-api-error-notification, nx-4elo3) ──────────────────────

describe("api_error rule", () => {
  it("fires desktop + tts with severity error for an api_error crash stop", () => {
    // Crash-stop path: the CC Stop hook reports stop_reason="api_error" and the
    // captured text rides on error_details.
    const drafts = hookRules.api_error!(
      payload({
        stop_reason: "api_error",
        error_details: "API Error: 503 Service Unavailable",
      }),
    );
    expect(channels(drafts)).toEqual(["desktop", "tts"]);
    for (const d of drafts!) {
      expect(d.severity).toBe("error");
      expect(d.body).toContain("503 Service Unavailable");
      // mx-7i4k: session id threads through for iOS deep-link.
      expect(d.sessionId).toBe("sess-test");
    }
  });

  it("returns null for a non-api event (no api-error draft)", () => {
    // A benign session_stop / generic payload must produce no api-error draft.
    expect(hookRules.api_error!(payload({ stop_reason: "oom" }))).toBeNull();
    expect(hookRules.api_error!(payload({ crash_flag: true }))).toBeNull();
    expect(hookRules.api_error!(payload({}))).toBeNull();
  });

  // nx-7tfim: the mid-session `reason: "api_error"` shape was removed — the
  // token-stream tail-watcher that used to produce it is gone and nothing
  // replaced it. `HookEventPayload.reason` no longer exists on the type
  // (compile-time guarantee); isApiError now reads stop_reason only.
  it("degrades to a bare api-error body when no error text is present", () => {
    const drafts = hookRules.api_error!(payload({ stop_reason: "api_error" }));
    expect(channels(drafts)).toEqual(["desktop", "tts"]);
    for (const d of drafts!) {
      // "nx: api error" — project-prefixed bare body, no trailing ": <text>".
      expect(d.body).toBe("nx: api error");
      expect(d.severity).toBe("error");
    }
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
