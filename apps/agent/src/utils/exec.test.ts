import { describe, test, expect } from "bun:test";
import {
  execJson,
  execText,
  ExecError,
  ExecTimeoutError,
  SpawnQueueOverflowError,
  isGatedCommand,
  GATED_COMMANDS,
  BD_DOLT_MAX_CONCURRENT,
  __getBdDoltInFlightForTest,
  __getGlobalInFlightForTest,
  __getGlobalQueueDepthForTest,
  __configureGlobalSpawnGateForTest,
  __resetGlobalSpawnGateForTest,
} from "./exec";

// NOTE: These tests use `sh` as the subprocess binary because `exec.ts`
// now routes through `safeSpawn`, which enforces an allowlist. `echo` /
// `pwd` / `sleep` are not on the allowlist — `sh -c '...'` is the
// canonical POSIX-portable way to exercise the wrapper's behavior.

describe("execText", () => {
  test("captures stdout from a successful command", async () => {
    const result = await execText("sh", ["-c", "echo hello world"]);
    expect(result.trim()).toBe("hello world");
  });

  test("throws ExecError on non-zero exit code", async () => {
    try {
      await execText("sh", ["-c", "exit 42"]);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(ExecError);
      const execErr = err as ExecError;
      expect(execErr.exitCode).toBe(42);
      expect(execErr.cmd).toBe("sh");
    }
  });

  test("throws ExecTimeoutError when command exceeds timeout", async () => {
    try {
      await execText("sh", ["-c", "sleep 10"], { timeout: 100 });
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(ExecTimeoutError);
      const timeoutErr = err as ExecTimeoutError;
      expect(timeoutErr.timeoutMs).toBe(100);
    }
  });

  test("respects cwd option", async () => {
    const result = await execText("sh", ["-c", "pwd"], { cwd: "/tmp" });
    // /tmp may be a symlink (e.g., /private/tmp on macOS)
    expect(result.trim()).toContain("tmp");
  });
});

describe("execJson", () => {
  test("parses valid JSON output", async () => {
    const result = await execJson<{ ok: boolean }>("sh", [
      "-c",
      'echo \'{"ok":true}\'',
    ]);
    expect(result).toEqual({ ok: true });
  });

  test("throws on non-zero exit code before parsing", async () => {
    try {
      // `;` is a shell metacharacter — requires trustArgs opt-out.
      await execJson(
        "sh",
        ["-c", "echo '{\"ok\":true}'; exit 1"],
        { trustArgs: true },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ExecError);
    }
  });

  test("throws on invalid JSON output", async () => {
    try {
      await execJson("sh", ["-c", "echo not json"]);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Failed to parse JSON");
    }
  });

  test("throws ExecTimeoutError when command exceeds timeout", async () => {
    try {
      await execJson("sh", ["-c", "sleep 10"], { timeout: 100 });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ExecTimeoutError);
    }
  });

  test("parses array JSON", async () => {
    const result = await execJson<number[]>("sh", ["-c", "echo [1,2,3]"]);
    expect(result).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// bd/dolt concurrency gate (nx-b6trw)
//
// `bd`/`dolt` aren't installed in the test sandbox, so these tests
// temporarily register `sh` in GATED_COMMANDS as a stand-in — `sh -c
// "sleep ..."` gives controllable, measurable subprocess duration. The gate
// itself only ever fires on the literal strings "bd"/"dolt" in production;
// mutating the exported GATED_COMMANDS set is a narrow, test-only seam.
// ---------------------------------------------------------------------------

describe("isGatedCommand", () => {
  test("matches bd and dolt only", () => {
    expect(isGatedCommand("bd")).toBe(true);
    expect(isGatedCommand("dolt")).toBe(true);
    expect(isGatedCommand("git")).toBe(false);
    expect(isGatedCommand("sh")).toBe(false);
    expect(isGatedCommand("tmux")).toBe(false);
  });
});

describe("bd/dolt concurrency gate", () => {
  test("bounds concurrency at the ceiling, drains the queue without starvation, and leaves non-gated commands unthrottled", async () => {
    GATED_COMMANDS.add("sh");
    try {
      const numCalls = BD_DOLT_MAX_CONCURRENT * 2;
      const sleepSeconds = 0.15;

      let inFlightMax = 0;
      const poll = setInterval(() => {
        inFlightMax = Math.max(inFlightMax, __getBdDoltInFlightForTest());
      }, 5);

      const gatedStart = Date.now();
      const gatedCalls = Array.from({ length: numCalls }, () =>
        execText("sh", ["-c", `sleep ${sleepSeconds}`]),
      );

      // Fire a non-gated call while the gated batch is queued/running. It
      // must complete quickly regardless of gated queue depth.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const nonGatedStart = Date.now();
      await execText("which", ["sh"]);
      const nonGatedDuration = Date.now() - nonGatedStart;

      // (2) Queued calls still eventually complete — no deadlock/starvation.
      await Promise.all(gatedCalls);
      const gatedDuration = Date.now() - gatedStart;

      clearInterval(poll);

      // (1) Concurrency never exceeds the configured ceiling, and the
      // batch was large enough (2x ceiling) that it actually saturated it.
      expect(inFlightMax).toBeLessThanOrEqual(BD_DOLT_MAX_CONCURRENT);
      expect(inFlightMax).toBe(BD_DOLT_MAX_CONCURRENT);

      // (3) The non-gated call was not queued behind gated traffic.
      expect(nonGatedDuration).toBeLessThan(sleepSeconds * 1000);

      // Two queued rounds of sleeps at the ceiling take at least 2x one round.
      expect(gatedDuration).toBeGreaterThanOrEqual(sleepSeconds * 1000 * 2 - 50);
    } finally {
      GATED_COMMANDS.delete("sh");
    }
  });
});

// ---------------------------------------------------------------------------
// Global process-wide spawn budget + bounded wait queue
// (nx-veo5g.2 #3 queue-depth cap + nx-veo5g.3 #1 process-wide budget — one
// coherent mechanism). These use the test-only reconfiguration seams so the
// overflow path is exercised deterministically with tiny limits, without
// spawning hundreds of real subprocesses. `sh` stays OUT of GATED_COMMANDS so
// only the GLOBAL gate is under test here.
// ---------------------------------------------------------------------------

describe("global spawn budget", () => {
  test("caps total concurrency across ALL commands, not just bd/dolt", async () => {
    __configureGlobalSpawnGateForTest(2, 128);
    try {
      let inFlightMax = 0;
      const poll = setInterval(() => {
        inFlightMax = Math.max(inFlightMax, __getGlobalInFlightForTest());
      }, 5);

      // 6 NON-gated calls; global budget is 2 → never more than 2 spawn at once.
      const calls = Array.from({ length: 6 }, () =>
        execText("sh", ["-c", "sleep 0.1"]),
      );
      await Promise.all(calls);
      clearInterval(poll);

      expect(inFlightMax).toBe(2);
      // Fully drained afterward — no leaked slots.
      expect(__getGlobalInFlightForTest()).toBe(0);
      expect(__getGlobalQueueDepthForTest()).toBe(0);
    } finally {
      __resetGlobalSpawnGateForTest();
    }
  });

  test("fails fast with SpawnQueueOverflowError when the wait queue is full, then drains without deadlock", async () => {
    // concurrency 1, queue cap 1: one running + one queued is the ceiling.
    __configureGlobalSpawnGateForTest(1, 1);
    try {
      // A holds the single slot.
      const a = execText("sh", ["-c", "sleep 0.2"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(__getGlobalInFlightForTest()).toBe(1);

      // B fills the single queue slot (waits, does not spawn yet).
      const b = execText("sh", ["-c", "sleep 0.2"]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(__getGlobalQueueDepthForTest()).toBe(1);

      // C overflows — rejected IMMEDIATELY without spawning (fail fast).
      let overflowErr: unknown;
      const cStart = Date.now();
      try {
        await execText("sh", ["-c", "sleep 0.2"]);
      } catch (err) {
        overflowErr = err;
      }
      const cDuration = Date.now() - cStart;
      expect(overflowErr).toBeInstanceOf(SpawnQueueOverflowError);
      // "Fail fast" — it did NOT wait on the 0.2s sleeps ahead of it.
      expect(cDuration).toBeLessThan(100);

      // The gate is NOT wedged: A drains, B proceeds off the queue, both resolve.
      await Promise.all([a, b]);
      expect(__getGlobalInFlightForTest()).toBe(0);
      expect(__getGlobalQueueDepthForTest()).toBe(0);

      // A fresh call after an overflow still works — proves no deadlock.
      const after = await execText("sh", ["-c", "echo ok"]);
      expect(after.trim()).toBe("ok");
    } finally {
      __resetGlobalSpawnGateForTest();
    }
  });

  test("a queued caller still runs to completion after the slot frees (no starvation)", async () => {
    __configureGlobalSpawnGateForTest(1, 8);
    try {
      const results = await Promise.all([
        execText("sh", ["-c", "echo one"]),
        execText("sh", ["-c", "echo two"]),
        execText("sh", ["-c", "echo three"]),
      ]);
      expect(results.map((r) => r.trim())).toEqual(["one", "two", "three"]);
      expect(__getGlobalInFlightForTest()).toBe(0);
    } finally {
      __resetGlobalSpawnGateForTest();
    }
  });
});
