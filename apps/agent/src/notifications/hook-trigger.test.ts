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

    await evaluateAndDispatch(db, manager, "tool_use_fail", payload({ tool_name: "Bash", error_message: "x" }));
    await evaluateAndDispatch(db, manager, "tool_use_fail", payload({ tool_name: "Bash", error_message: "y" }));

    // First call: 1 send (desktop). Second call: suppressed.
    expect(sends).toHaveLength(1);
  });

  it("does not suppress different suppression keys", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "tool_use_fail", payload({ tool_name: "Bash", error_message: "x" }));
    await evaluateAndDispatch(db, manager, "tool_use_fail", payload({ tool_name: "Edit", error_message: "y" }));

    expect(sends).toHaveLength(2); // 1 channel × 2 distinct tools
  });

  it("fires again after the window expires", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    const realNow = Date.now;
    let fakeTime = 1_000_000;
    const dateSpy = spyOn(Date, "now").mockImplementation(() => fakeTime);

    try {
      await evaluateAndDispatch(db, manager, "tool_use_fail", payload({ tool_name: "Bash", error_message: "x" }));
      // Advance past the window.
      fakeTime += SUPPRESSION_WINDOW_MS + 1;
      await evaluateAndDispatch(db, manager, "tool_use_fail", payload({ tool_name: "Bash", error_message: "y" }));
    } finally {
      dateSpy.mockRestore();
      // belt-and-braces — make sure we restored to the real clock
      expect(Date.now()).toBeGreaterThan(realNow() - 1_000);
    }

    expect(sends).toHaveLength(2); // both calls fired desktop
  });

  it("never suppresses permission_request", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "permission_request", payload({ tool_name: "Edit" }));
    await evaluateAndDispatch(db, manager, "permission_request", payload({ tool_name: "Edit" }));
    await evaluateAndDispatch(db, manager, "permission_request", payload({ tool_name: "Edit" }));

    expect(sends).toHaveLength(6); // 3 calls × 2 channels (desktop + tts)
  });

  it("suppresses session_stop crash per session_id", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "session_stop", payload({ crash_flag: true, session_id: "sess-1" }));
    await evaluateAndDispatch(db, manager, "session_stop", payload({ crash_flag: true, session_id: "sess-1" }));

    expect(sends).toHaveLength(1); // first call only
  });
});

// ─── Settings filter ─────────────────────────────────────────────────────────

describe("settings filter", () => {
  it("strips tts when tts_enabled=false", async () => {
    const db = makeFakeDb({ ttsEnabled: false, bannerEnabled: true });
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "permission_request", payload({ tool_name: "Edit" }));

    expect(sends.map((s) => s.channel)).toEqual(["desktop"]);
  });

  it("strips desktop when banner_enabled=false", async () => {
    const db = makeFakeDb({ ttsEnabled: true, bannerEnabled: false });
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "tool_use_fail", payload({ tool_name: "Bash", error_message: "x" }));

    // tool_use_fail has desktop only — desktop gets stripped, nothing fires.
    expect(sends).toHaveLength(0);
  });

  it("collapses to no-op when both desktop and tts are off", async () => {
    const db = makeFakeDb({ ttsEnabled: false, bannerEnabled: false });
    const { manager, sends } = makeFakeManager();

    // permission_request channels = [desktop, tts] — both stripped.
    await evaluateAndDispatch(db, manager, "permission_request", payload({ tool_name: "Edit" }));

    expect(sends).toHaveLength(0);
  });

  it("fails open when settings row is missing", async () => {
    const db = makeFakeDb(null);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "tool_use_fail", payload({ tool_name: "Bash", error_message: "x" }));

    expect(sends).toHaveLength(1); // desktop only (slack removed)
  });

  it("fails open when settings read throws", async () => {
    const db = makeFakeDb(null, { throws: true });
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(db, manager, "tool_use_fail", payload({ tool_name: "Bash", error_message: "x" }));

    expect(sends).toHaveLength(1);
  });
});

// ─── Session name threading (nx-20caf) ─────────────────────────────────────────

describe("custom session name threading", () => {
  it("threads sessionName into manager.send extras when session_name is present", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(
      db,
      manager,
      "permission_request",
      payload({ tool_name: "Bash", session_name: "backend wave" }),
    );

    // permission_request -> desktop + tts, BOTH carrying the session name.
    expect(sends).toHaveLength(2);
    for (const s of sends) {
      expect(s.extras?.sessionName).toBe("backend wave");
      // mx-7i4k: sessionId rides alongside (payload() default session_id).
      expect(s.extras?.sessionId).toBe("sess-1");
    }
  });

  it("threads sessionId even when session_name is absent (mx-7i4k)", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(
      db,
      manager,
      "permission_request",
      payload({ tool_name: "Edit" }),
    );

    // session_name absent -> sessionName undefined, but the session_id still
    // threads through for iOS tap-to-session deep-linking.
    expect(sends).toHaveLength(2);
    for (const s of sends) {
      expect(s.extras?.sessionName).toBeUndefined();
      expect(s.extras?.sessionId).toBe("sess-1");
    }
  });

  it("treats an empty-string session_name as no session name (sessionId still threads)", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(
      db,
      manager,
      "permission_request",
      payload({ tool_name: "Edit", session_name: "" }),
    );

    expect(sends).toHaveLength(2);
    for (const s of sends) {
      expect(s.extras?.sessionName).toBeUndefined();
      expect(s.extras?.sessionId).toBe("sess-1");
    }
  });

  it("passes undefined extras when both session_name and session_id are absent", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager();

    await evaluateAndDispatch(
      db,
      manager,
      "permission_request",
      // override session_id to empty so neither transport field is present.
      payload({ tool_name: "Edit", session_id: "" }),
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

  it("does not throw when a single channel send rejects", async () => {
    const db = makeFakeDb(ALL_ENABLED);
    const { manager, sends } = makeFakeManager({ throwOn: "tts" });

    await expect(
      evaluateAndDispatch(db, manager, "permission_request", payload({ tool_name: "Edit" })),
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
