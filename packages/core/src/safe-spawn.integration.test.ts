/**
 * Integration test: safeSpawn against a real tmux binary.
 *
 * This complements the unit tests in `./safe-spawn.test.ts` (task 2.3) with
 * an end-to-end exercise of the primary use case: spawning tmux to create,
 * query, and tear down a detached session. The goal is to prove the wrapper
 * works in the environment it is meant for — a tmux harness on a real agent.
 *
 * Requirements:
 *   - `tmux` must be on PATH. If not, the whole suite skips (test.skipIf).
 *
 * Isolation:
 *   - Uses a session name derived from pid + timestamp + random nonce so
 *     concurrent test runs and the user's real tmux sessions never collide.
 *   - afterAll runs `tmux kill-session` with `|| true` semantics so a
 *     mid-test failure cannot leak state.
 *
 * Coverage:
 *   - new-session -d creates a detached session (exitCode 0)
 *   - list-sessions -F shows the session name we created
 *   - abort() on a long-running tmux subprocess exits quickly
 *   - AbortSignal path externally kills a pending tmux subprocess
 *   - kill-session teardown succeeds and the session is gone after
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { safeSpawn } from "./safe-spawn";

// ---------------------------------------------------------------------------
// Environment probe
// ---------------------------------------------------------------------------

/**
 * Detect whether `tmux` is on PATH. Bun.which is synchronous and returns null
 * when the binary is missing — exactly what we need for `test.skipIf`.
 */
const TMUX_AVAILABLE = Bun.which("tmux") !== null;

/**
 * Unique session name for this test run. Embeds pid + timestamp + random so
 * two concurrent `bun test` invocations never pick the same name, and we
 * cannot collide with the user's real tmux sessions either.
 */
const SESSION_NAME = `nexus-safespawn-test-${process.pid}-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect the full stdout of a handle as a UTF-8 string. */
async function readStdout(handle: { stdout: ReadableStream | number | undefined }): Promise<string> {
  if (!(handle.stdout instanceof ReadableStream)) return "";
  return await new Response(handle.stdout).text();
}

/**
 * Best-effort tmux session teardown. Swallows errors because a test failure
 * may have left us in a state where the session no longer exists — we still
 * want the rest of the teardown to run.
 */
async function killSession(name: string): Promise<void> {
  try {
    const handle = safeSpawn("tmux", ["kill-session", "-t", name]);
    await handle.exitCode;
  } catch {
    // Session already gone or tmux missing — either way, nothing to clean up.
  }
}

/** List all tmux session names (one per line). Empty string if none. */
async function listSessionNames(): Promise<string[]> {
  const handle = safeSpawn("tmux", ["list-sessions", "-F", "#{session_name}"]);
  const text = await readStdout(handle);
  await handle.exitCode;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Teardown guard — run even if a test throws mid-suite.
// ---------------------------------------------------------------------------

beforeAll(() => {
  if (!TMUX_AVAILABLE) {
    // eslint-disable-next-line no-console
    console.warn("safe-spawn.integration.test.ts: tmux not found on PATH — skipping suite");
  }
});

afterAll(async () => {
  if (TMUX_AVAILABLE) {
    await killSession(SESSION_NAME);
  }
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!TMUX_AVAILABLE)("safeSpawn integration — real tmux", () => {
  test("spawns tmux new-session -d and exits cleanly", async () => {
    const handle = safeSpawn("tmux", ["new-session", "-d", "-s", SESSION_NAME]);
    expect(handle.pid).toBeGreaterThan(0);

    const code = await handle.exitCode;
    expect(code).toBe(0);
  });

  test("list-sessions shows the newly-created session", async () => {
    const names = await listSessionNames();
    expect(names).toContain(SESSION_NAME);
  });

  test("abort() on a long-running tmux subprocess exits quickly", async () => {
    // `tmux wait-for <channel>` blocks until another process signals the
    // channel. We use it to create a subprocess that would hang indefinitely
    // without our intervention — the perfect test for abort().
    const handle = safeSpawn("tmux", ["wait-for", `nexus-wait-${SESSION_NAME}`]);
    const start = Date.now();
    const code = await handle.abort();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    expect(typeof code).toBe("number");
  });

  test("AbortSignal externally aborts a long-running tmux subprocess", async () => {
    const ac = new AbortController();
    const handle = safeSpawn("tmux", ["wait-for", `nexus-wait-signal-${SESSION_NAME}`], {
      signal: ac.signal,
    });

    const start = Date.now();
    ac.abort();
    const code = await handle.exitCode;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    expect(typeof code).toBe("number");
  });

  test("kill-session teardown removes the session", async () => {
    // Verify the session still exists before we tear it down.
    const before = await listSessionNames();
    expect(before).toContain(SESSION_NAME);

    // Tear down via safeSpawn — mirrors what production callers would do.
    const killHandle = safeSpawn("tmux", ["kill-session", "-t", SESSION_NAME]);
    const killCode = await killHandle.exitCode;
    expect(killCode).toBe(0);

    // And confirm it's gone.
    const after = await listSessionNames();
    expect(after).not.toContain(SESSION_NAME);
  });
});
