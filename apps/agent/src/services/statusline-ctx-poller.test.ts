/**
 * Unit tests for the statusline-ctx-poller (detach-context-push-from-
 * statusline-lifecycle, task 3.1/3.2a).
 *
 * `pollOnce()` hard-codes the real `~/.claude/scripts/state` directory
 * (`STATE_DIR`, exported via `__testing`) — this suite MUST NOT read or write
 * that real path. Instead, `node:fs`'s `readdirSync`/`readFileSync` are
 * spied restorably (mirroring `process-watcher.test.ts`'s own
 * `spyOn(realFs, "readlinkSync")` pattern: spy on the real `node:fs`
 * namespace object rather than a process-global `mock.module`, so the spy
 * only affects this file and is fully undone in `afterAll`) and made to
 * serve an in-memory fixture keyed on `STATE_DIR` — no other path is ever
 * requested by the module under test, but the mock delegates to the real
 * implementation for any other path just in case, matching that same
 * file's defensive-delegation style.
 *
 * The second half of task 3.1 (`applyStatuslineSnapshot` + a subsequent
 * `handleGetSessionContext` call) reuses the exact assertion shape
 * `session-context.test.ts` already established for this endpoint (`fakeDb`
 * stub + `resetSessionContextStore()` + `spyOn(Date, "now")`), rather than
 * reinventing it.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  spyOn,
} from "bun:test";
import * as realFs from "node:fs";
import type { Db } from "@nexus/db";

import {
  pollOnce,
  startStatuslineCtxPoller,
  __testing,
} from "./statusline-ctx-poller";
import {
  applyStatuslineSnapshot,
  handleGetSessionContext,
  resetSessionContextStore,
} from "../routes/session-context";

const { STATE_DIR } = __testing;

// ── Fixture-backed fs mock, scoped to STATE_DIR only ───────────────────────

let dirEntries: string[] = [];
let fileContents: Record<string, string> = {};

/** Replace the whole state-dir fixture for the next `pollOnce()` call. */
function setStateDirFixture(files: Record<string, string>): void {
  fileContents = { ...files };
  dirEntries = Object.keys(files);
}

const realReaddirSync = realFs.readdirSync;
const realReadFileSync = realFs.readFileSync;

let readdirSpy: ReturnType<typeof spyOn<typeof realFs, "readdirSync">>;
let readFileSpy: ReturnType<typeof spyOn<typeof realFs, "readFileSync">>;

beforeAll(() => {
  readdirSpy = spyOn(realFs, "readdirSync").mockImplementation(((
    path: unknown,
    ...rest: unknown[]
  ) => {
    if (path === STATE_DIR) return dirEntries;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (realReaddirSync as any)(path, ...rest);
  }) as typeof realFs.readdirSync);

  readFileSpy = spyOn(realFs, "readFileSync").mockImplementation(((
    path: unknown,
    ...rest: unknown[]
  ) => {
    if (typeof path === "string" && path.startsWith(`${STATE_DIR}/`)) {
      const fileName = path.slice(STATE_DIR.length + 1);
      if (fileName in fileContents) return fileContents[fileName]!;
      throw new Error(`ENOENT: no such fixture file: ${fileName}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (realReadFileSync as any)(path, ...rest);
  }) as typeof realFs.readFileSync);
});

afterAll(() => {
  readdirSpy.mockRestore();
  readFileSpy.mockRestore();
});

beforeEach(() => {
  setStateDirFixture({});
  resetSessionContextStore();
});

// ── Fixture helpers ─────────────────────────────────────────────────────────

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function snapshotJson(opts: {
  used_percentage: number;
  context_window_size?: number;
  saved_at: number;
}): string {
  return JSON.stringify(opts);
}

/** Minimal chainable stub for `getSessionByCcSessionId`'s db-query shape. */
function fakeDb(row: { model: string | null } | null): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(row ? [row] : []),
        }),
      }),
    }),
  } as unknown as Db;
}

// ── pollOnce() — pure parsing/matching logic (task 3.1) ────────────────────

describe("pollOnce — parses and applies statusline-ctx snapshot files", () => {
  test("well-formed snapshot is parsed and applied", async () => {
    setStateDirFixture({
      "statusline-ctx.sess-good.json": snapshotJson({
        used_percentage: 42,
        context_window_size: 200000,
        saved_at: nowSecs(),
      }),
    });

    const applied = pollOnce();
    expect(applied).toBe(1);

    const getRes = await handleGetSessionContext(
      new Request("http://127.0.0.1/sessions/sess-good/context"),
      "sess-good",
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.usedPercentage).toBe(42);
    expect(body.contextWindowSize).toBe(200000);
  });

  test("a file whose saved_at exceeds the freshness window is skipped, not applied", async () => {
    setStateDirFixture({
      "statusline-ctx.sess-stale.json": snapshotJson({
        used_percentage: 62,
        saved_at: nowSecs() - 700, // past the 600s CACHE_TTL_MS window
      }),
    });

    const applied = pollOnce();
    expect(applied).toBe(0);

    const getRes = await handleGetSessionContext(
      new Request("http://127.0.0.1/sessions/sess-stale/context"),
      "sess-stale",
    );
    expect(getRes.status).toBe(404);
  });

  test("a malformed file (bad JSON, missing fields) is skipped without throwing; other well-formed files in the same batch still get applied", async () => {
    setStateDirFixture({
      "statusline-ctx.sess-bad-json.json": "{ not valid json",
      "statusline-ctx.sess-missing-fields.json": JSON.stringify({ foo: 1 }),
      "statusline-ctx.sess-good.json": snapshotJson({
        used_percentage: 10,
        saved_at: nowSecs(),
      }),
      "unrelated-file.txt": "not a snapshot at all",
    });

    let applied = 0;
    expect(() => {
      applied = pollOnce();
    }).not.toThrow();
    expect(applied).toBe(1);

    const goodRes = await handleGetSessionContext(
      new Request("http://127.0.0.1/sessions/sess-good/context"),
      "sess-good",
    );
    expect(goodRes.status).toBe(200);

    const badRes = await handleGetSessionContext(
      new Request("http://127.0.0.1/sessions/sess-bad-json/context"),
      "sess-bad-json",
    );
    expect(badRes.status).toBe(404);

    const missingRes = await handleGetSessionContext(
      new Request("http://127.0.0.1/sessions/sess-missing-fields/context"),
      "sess-missing-fields",
    );
    expect(missingRes.status).toBe(404);
  });

  test("an empty directory produces zero applies", () => {
    setStateDirFixture({});
    expect(pollOnce()).toBe(0);
  });
});

// ── applyStatuslineSnapshot — direct write path (task 3.1) ─────────────────

describe("applyStatuslineSnapshot — writes the same shape handleGetSessionContext reads back", () => {
  test("usedPercentage round-trips through handleGetSessionContext", async () => {
    applyStatuslineSnapshot("sess-direct", 77, 150000);

    const getRes = await handleGetSessionContext(
      new Request("http://127.0.0.1/sessions/sess-direct/context"),
      "sess-direct",
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.usedPercentage).toBe(77);
    expect(body.contextWindowSize).toBe(150000);
  });

  test("with a db + a session row carrying a real model, handleGetSessionContext returns the expected model letter", async () => {
    applyStatuslineSnapshot("sess-with-model", 33, null);

    const getRes = await handleGetSessionContext(
      new Request("http://127.0.0.1/sessions/sess-with-model/context"),
      "sess-with-model",
      fakeDb({ model: "claude-opus-4-8" }),
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.usedPercentage).toBe(33);
    expect(body.model).toBe("O");
  });
});

// ── startStatuslineCtxPoller — start/stop lifecycle (task 3.2a) ────────────

describe("startStatuslineCtxPoller — lifecycle", () => {
  test("stop() halts further polling — no dangling timer keeps ticking after stop", async () => {
    setStateDirFixture({});
    const callsBefore = readdirSpy.mock.calls.length;

    const handle = startStatuslineCtxPoller({ intervalMs: 15 });
    // Let several ticks fire (immediate first tick + a few interval ticks).
    await new Promise((r) => setTimeout(r, 70));
    const callsAtStop = readdirSpy.mock.calls.length;
    expect(callsAtStop).toBeGreaterThan(callsBefore);

    handle.stop();
    // If the interval were still alive, this window would produce more ticks.
    await new Promise((r) => setTimeout(r, 100));
    const callsAfterWait = readdirSpy.mock.calls.length;
    expect(callsAfterWait).toBe(callsAtStop);
  });

  test("stop() is safe to call more than once", () => {
    const handle = startStatuslineCtxPoller({ intervalMs: 1000 });
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });
});
