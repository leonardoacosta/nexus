/**
 * Unit tests for `hook-trigger.ts` — suppression cache + settings filter +
 * NotificationManager.send dispatch. The DB and the manager are fakes; the
 * tests exercise the orchestrator logic in isolation.
 */

import {
  describe,
  expect,
  it,
  beforeEach,
  spyOn,
  mock,
} from "bun:test";

import {
  evaluateAndDispatch,
  SUPPRESSION_WINDOW_MS,
  _clearSuppressionForTests,
} from "./hook-trigger";
import type { NotificationManager } from "./manager";
import type { Db } from "@nexus/db";
import type { HookEventPayload } from "../routes/hooks-types";

// ─── Fakes ───────────────────────────────────────────────────────────────────

interface SettingsRow {
  ttsEnabled: boolean;
  bannerEnabled: boolean;
}

/**
 * Build a fake `Db` whose only method we care about is
 * `db.query.notificationSettings.findFirst`. Returns `row` on each call (or
 * undefined when row is null, mirroring Drizzle's findFirst contract).
 */
function makeFakeDb(row: SettingsRow | null, opts: { throws?: boolean } = {}): Db {
  return {
    query: {
      notificationSettings: {
        findFirst: () => {
          if (opts.throws) {
            return Promise.reject(new Error("settings read boom"));
          }
          return Promise.resolve(row ?? undefined);
        },
      },
    },
  } as unknown as Db;
}

interface CapturedSend {
  channel: string;
  title: string;
  body: string;
  // nx-20caf: capture the transport-only extras arg so tests can assert the
  // custom session name is threaded through to manager.send().
  extras?: { items?: string[]; logPath?: string; sessionName?: string; sessionId?: string };
}

function makeFakeManager(opts: { throwOn?: string } = {}): {
  manager: NotificationManager;
  sends: CapturedSend[];
} {
  const sends: CapturedSend[] = [];
  const manager = {
    send: mock(async (n: any, extras?: any) => {
      if (opts.throwOn && n.channel === opts.throwOn) {
        throw new Error(`send boom on ${n.channel}`);
      }
      sends.push({ channel: n.channel, title: n.title, body: n.body, extras });
      return n;
    }),
  } as unknown as NotificationManager;
  return { manager, sends };
}

function payload(overrides: Partial<HookEventPayload> = {}): HookEventPayload {
  return {
    session_id: "sess-1",
    project: "nx",
    ...overrides,
  };
}

const ALL_ENABLED: SettingsRow = { ttsEnabled: true, bannerEnabled: true };

beforeEach(() => {
  _clearSuppressionForTests();
});

// ─── Suppression ─────────────────────────────────────────────────────────────

describe("suppression cache", () => {
  it("suppresses the same key within the window", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "hook_failure", payload({ hook_name: "post_compact", error_message: "x" }));
    await evaluateAndDispatch(db, manager, "hook_failure", payload({ hook_name: "post_compact", error_message: "y" }));

    // First call: 1 send (desktop). Second call: suppressed.
    expect(sends).toHaveLength(1);
  });

  it("does not suppress different suppression keys", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "hook_failure", payload({ hook_name: "post_compact", error_message: "x" }));
    await evaluateAndDispatch(db, manager, "hook_failure", payload({ hook_name: "session_stop", error_message: "y" }));

    expect(sends).toHaveLength(2); // 1 channel × 2 distinct hook names
  });

  it("fires again after the window expires", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    const realNow = Date.now;
    let fakeTime = 1_000_000;
    const dateSpy = spyOn(Date, "now").mockImplementation(() => fakeTime);

    try {
      await evaluateAndDispatch(db, manager, "hook_failure", payload({ hook_name: "post_compact", error_message: "x" }));
      // Advance past the window.
      fakeTime += SUPPRESSION_WINDOW_MS + 1;
      await evaluateAndDispatch(db, manager, "hook_failure", payload({ hook_name: "post_compact", error_message: "y" }));
    } finally {
      dateSpy.mockRestore();
      // belt-and-braces — make sure we restored to the real clock
      expect(Date.now()).toBeGreaterThan(realNow() - 1_000);
    }

    expect(sends).toHaveLength(2); // both calls fired desktop
  });

  // drop-permission-request-tts-draft (nx-okdvj, 2026-07-16): permission_request
  // no longer has a notification rule at all, so its dedicated 2s suppression
  // window (formerly PERMISSION_REQUEST_SUPPRESSION_WINDOW_MS, collapsing CC's
  // duplicate same-session hook-lifecycle pair for one logical permission
  // prompt) is dead — evaluateAndDispatch no-ops before suppression is ever
  // consulted. Replaces the three prior tests exercising that window
  // (dedupe-permission-request-notifications nx-snqyn, nx-ves8b, nx-fqi1m).
  it("never dispatches for permission_request (rule removed)", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "permission_request", payload({ tool_name: "Edit", session_id: "sess-1" }));
    await evaluateAndDispatch(db, manager, "permission_request", payload({ tool_name: "Edit", session_id: "sess-1" }));

    expect(sends).toHaveLength(0);
  });

  it("suppresses session_stop crash per session_id", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "session_stop", payload({ crash_flag: true, session_id: "sess-1" }));
    await evaluateAndDispatch(db, manager, "session_stop", payload({ crash_flag: true, session_id: "sess-1" }));

    expect(sends).toHaveLength(1); // first call only
  });

  // add-api-error-notification (nx-43gyj): a multi-minute 529 outage emits many
  // api-error lines on ONE session; the per-session `api_error:<session_id>` key
  // collapses them to a single delivered notification inside the window.
  it("collapses three rapid api_error evaluations on one session to one delivery", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    const apiErr = (text: string) =>
      payload({ stop_reason: "api_error", error_message: text, session_id: "sess-1" });

    await evaluateAndDispatch(db, manager, "api_error", apiErr("API Error: 529 Overloaded"));
    await evaluateAndDispatch(db, manager, "api_error", apiErr("API Error: 529 Overloaded"));
    await evaluateAndDispatch(db, manager, "api_error", apiErr("API Error: 529 Overloaded"));

    // apiErrorRule emits desktop + tts. Only the FIRST evaluation survives
    // suppression, so exactly 2 sends (1 delivery × 2 channels) land.
    expect(sends).toHaveLength(2);
    expect(sends.map((s) => s.channel).sort()).toEqual(["desktop", "tts"]);
  });

  it("delivers independently for two distinct sessions in the same window (keys do not collide)", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    const apiErr = (sessionId: string) =>
      payload({ stop_reason: "api_error", error_message: "API Error: 529 Overloaded", session_id: sessionId });

    // Two distinct sessions, same window: each keys on its own session_id, so
    // each delivers once (desktop + tts) -> 4 sends total.
    await evaluateAndDispatch(db, manager, "api_error", apiErr("sess-A"));
    await evaluateAndDispatch(db, manager, "api_error", apiErr("sess-B"));

    expect(sends).toHaveLength(4);
    // Sanity: a duplicate on sess-A inside the window adds nothing.
    await evaluateAndDispatch(db, manager, "api_error", apiErr("sess-A"));
    expect(sends).toHaveLength(4);
  });
});

// ─── Settings filter ─────────────────────────────────────────────────────────

describe("settings filter", () => {
  it("strips tts when tts_enabled=false", async () => {
    const db = makeFakeDb({ ttsEnabled: false, bannerEnabled: true });
    const { manager, sends } = makeFakeManager();

    // apiErrorRule is the remaining desktop+tts rule (permission_request no
    // longer maps to a rule — drop-permission-request-tts-draft, nx-okdvj).
    await evaluateAndDispatch(db, manager, "api_error", payload({ stop_reason: "api_error", error_message: "x" }));

    expect(sends.map((s) => s.channel)).toEqual(["desktop"]);
  });

  it("strips desktop when banner_enabled=false", async () => {
    const db = makeFakeDb({ ttsEnabled: true, bannerEnabled: false });
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "hook_failure", payload({ hook_name: "post_compact", error_message: "x" }));

    // hook_failure has desktop only — desktop gets stripped, nothing fires.
    expect(sends).toHaveLength(0);
  });

  it("collapses to no-op when both desktop and tts are off", async () => {
    const db = makeFakeDb({ ttsEnabled: false, bannerEnabled: false });
    const { manager, sends } = makeFakeManager();

    // api_error channels = [desktop, tts] — both stripped.
    await evaluateAndDispatch(db, manager, "api_error", payload({ stop_reason: "api_error", error_message: "x" }));

    expect(sends).toHaveLength(0);
  });

  it("fails open when settings row is missing", async () => {
    const db = makeFakeDb(null);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "hook_failure", payload({ hook_name: "post_compact", error_message: "x" }));

    expect(sends).toHaveLength(1); // desktop only (slack removed)
  });

  it("fails open when settings read throws", async () => {
    const db = makeFakeDb(null, { throws: true });
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "hook_failure", payload({ hook_name: "post_compact", error_message: "x" }));

    expect(sends).toHaveLength(1);
  });
});

// ─── Session id threading (mx-7i4k) ────────────────────────────────────────────
//
// drop-permission-request-tts-draft (nx-okdvj, 2026-07-16): this block used to
// exercise the generic draft.sessionName/sessionId → manager.send() extras
// threading via permissionRequestRule (the only rule that ever set
// sessionName). That rule is gone, and no surviving rule sets sessionName —
// sessionName-threading coverage now lives entirely in
// manager-session-name.test.ts, which asserts NotificationManager.send()'s
// extras plumbing directly, independent of which rule produced the draft.
// apiErrorRule is the remaining rule that threads sessionId, so it's the
// vehicle here for the dispatcher-level (hook-trigger.ts) half of the
// threading contract.

describe("session id threading via apiErrorRule", () => {
  it("threads sessionId into manager.send extras when session_id is present", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(
      db,
      manager,
      "api_error",
      payload({ stop_reason: "api_error", error_message: "boom", session_id: "sess-1" }),
    );

    // apiErrorRule -> desktop + tts, both carrying the session id.
    expect(sends).toHaveLength(2);
    for (const s of sends) {
      expect(s.extras?.sessionId).toBe("sess-1");
    }
  });

  it("passes undefined extras when session_id is absent", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(
      db,
      manager,
      "api_error",
      // override session_id to empty so the transport field is absent.
      payload({ stop_reason: "api_error", error_message: "boom", session_id: "" }),
    );

    expect(sends).toHaveLength(2);
    for (const s of sends) {
      expect(s.extras).toBeUndefined();
    }
  });
});

// ─── Resilience ──────────────────────────────────────────────────────────────

describe("resilience", () => {
  it("does not throw when an unknown event type is supplied", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "session_heartbeat", payload());
    await evaluateAndDispatch(db, manager, "agent_spawn", payload());
    await evaluateAndDispatch(db, manager, "totally_made_up", payload());

    expect(sends).toHaveLength(0);
  });

  // remove-tool-use-fail-notification (nx-l08rs): tool_use_fail was removed
  // from the rule registry entirely — cc's telemetry.sh still POSTs this
  // event for session_events persistence, but it must never produce a
  // notification for any client again. `evaluateAndDispatch` no-ops via the
  // same "event type has no notification rule" branch as any other unmapped
  // event type.
  it("no longer dispatches a notification for tool_use_fail", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "tool_use_fail", payload({ tool_name: "Bash", error_message: "permission denied" }));

    expect(sends).toHaveLength(0);
  });

  it("does not throw when a single channel send rejects", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager({ throwOn: "tts" });

    await expect(
      evaluateAndDispatch(db, manager, "api_error", payload({ stop_reason: "api_error", error_message: "boom" })),
    ).resolves.toBeUndefined();

    // desktop still landed even though tts rejected.
    expect(sends.map((s) => s.channel)).toEqual(["desktop"]);
  });

  it("skips dispatch when the rule predicate returns null", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "session_summary", payload({ cost_usd: 0.10 }));
    await evaluateAndDispatch(db, manager, "session_stop", payload({})); // no crash

    expect(sends).toHaveLength(0);
  });
});

// ─── [4.3] Residual hook: orchestration-event routing ────────────────────────
//
// read-cc-telemetry-from-influxdb § Residual Hook Boundary: the cc hook pipeline
// is retained ONLY for signals with no VictoriaMetrics analog — orchestration-
// lifecycle events (`command_start`/`command_end` carrying `run_id`/`spec`) and
// welded side-effects. Those orchestration events route through the residual
// hook path but MUST NOT capture cost/token or produce a spurious user
// notification (they have no notification rule). This pins that the residual
// dispatcher accepts a `command_start`-with-`run_id` payload gracefully — no
// send, no throw — after the metric/cost/token capture path was deleted.

describe("residual hook: orchestration events (4.3)", () => {
  it("routes a command_start (run_id + spec) as a graceful no-op — no send, no throw", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    const orchestration: HookEventPayload = payload({
      hook_event_name: "command_start",
      run_id: "run-abc123",
      spec: "read-cc-telemetry-from-influxdb",
      wave: 1,
      phase: "e2e",
    });

    await expect(
      evaluateAndDispatch(db, manager, "command_start", orchestration),
    ).resolves.toBeUndefined();

    // No notification rule for command_start → routed but never notified,
    // and never captured as a cost/token source of truth.
    expect(sends).toHaveLength(0);
    // The orchestration identity survives on the payload contract.
    expect(orchestration.run_id).toBe("run-abc123");
    expect(orchestration.spec).toBe("read-cc-telemetry-from-influxdb");
  });
});
