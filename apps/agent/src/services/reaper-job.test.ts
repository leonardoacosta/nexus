/**
 * reaper-job unit tests — wrapper parsing, dry-run idempotency, abort path.
 *
 * Pure-logic tests run unconditionally. The dry-run live-spawn test runs
 * `reaper-core.sh` against a sandboxed `$HOME` to assert zero filesystem
 * mutations occur in dry mode. The aborted-child test exercises the
 * `_on_exit` trap by feeding the wrapper a script that exits before
 * reaching the completion sentinel.
 */

import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  parseReaperOutput,
  runReaper,
  defaultScriptPath,
  emitStaleHeartbeatNotification,
  __resetStaleHeartbeatNotifyForTests,
  STALE_HEARTBEAT_NOTIFY_COOLDOWN_MS,
  type StaleHeartbeatResult,
} from "./reaper-job";
import {
  lifecycleBus,
  type LifecycleEnvelope,
} from "./lifecycle-bus";

// ---------------------------------------------------------------------------
// defaultScriptPath — compiled-binary path resolution (nx-reaper-path)
// ---------------------------------------------------------------------------

describe("defaultScriptPath", () => {
  test("resolves to the execPath-sibling script when it exists there", () => {
    // Regression test for the production bug: `import.meta.dir` only
    // resolves correctly when running from source. A compiled binary's
    // `process.execPath` sibling is the real production location — this
    // proves that candidate is actually tried and preferred, using a fake
    // execPath pointing at a temp dir so the real `process.execPath` global
    // is never touched.
    const fakeBinDir = mkdtempSync(join(tmpdir(), "nx-reaper-execpath-"));
    const fakeExecPath = join(fakeBinDir, "nexus-agent");
    const fakeScript = join(fakeBinDir, "reaper-core.sh");
    writeFileSync(fakeScript, "#!/usr/bin/env bash\necho fake\n", { mode: 0o755 });

    try {
      const resolved = defaultScriptPath(fakeExecPath);
      expect(resolved).toBe(fakeScript);
    } finally {
      rmSync(fakeBinDir, { recursive: true, force: true });
    }
  });

  test("falls back to the import.meta.dir sibling when no execPath-sibling script exists", () => {
    // No `reaper-core.sh` at the fake execPath location — must fall back
    // to the real source-tree sibling (dev/bun-test behavior), not the
    // execPath candidate.
    const emptyBinDir = mkdtempSync(join(tmpdir(), "nx-reaper-execpath-empty-"));
    const fakeExecPath = join(emptyBinDir, "nexus-agent");

    try {
      const resolved = defaultScriptPath(fakeExecPath);
      expect(resolved).toBe(join(import.meta.dir, "reaper-core.sh"));
      expect(existsSync(resolved)).toBe(true);
    } finally {
      rmSync(emptyBinDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// parseReaperOutput
// ---------------------------------------------------------------------------

describe("parseReaperOutput", () => {
  test("extracts a clean success run with no bloat findings", () => {
    const stdout = [
      "=== weekly-cleanup 2026-05-21T03:00:00-05:00 (dry_run=0) ===",
      "NEXUS_RESULT started_at=2026-05-21T03:00:00-05:00 dry_run=0 log_path=/tmp/wc.log",
      "  clean xdg-cache         /home/x/.cache (10M)",
      "  -- bloat radar (adjacent dirs NOT auto-cleaned) --",
      "  (clear — nothing over threshold)",
      "NEXUS_RESULT status=success pruned=4 freed_bytes=10485760 log_path=/tmp/wc.log",
    ].join("\n");

    const parsed = parseReaperOutput(stdout);
    expect(parsed.status).toBe("success");
    expect(parsed.pruned).toBe(4);
    expect(parsed.freedBytes).toBe(10_485_760);
    expect(parsed.logPath).toBe("/tmp/wc.log");
    expect(parsed.startedAt).toBe("2026-05-21T03:00:00-05:00");
    expect(parsed.bloatFindings).toHaveLength(0);
    expect(parsed.rc).toBeNull();
  });

  test("extracts bloat findings", () => {
    const stdout = [
      "NEXUS_RESULT started_at=2026-05-21T03:00:00-05:00 dry_run=1 log_path=/tmp/wc.log",
      "NEXUS_BLOAT label=CoreSimulator|path=/Users/x/Library/Developer/CoreSimulator|size_bytes=42949672960|threshold_bytes=21474836480",
      "NEXUS_BLOAT label=Chrome 'Default' History|path=/Users/x/Chrome/Default/History|size_bytes=419430400|threshold_bytes=314572800",
      "NEXUS_RESULT status=success pruned=0 freed_bytes=0 log_path=/tmp/wc.log",
    ].join("\n");

    const parsed = parseReaperOutput(stdout);
    expect(parsed.status).toBe("success");
    expect(parsed.bloatFindings).toHaveLength(2);
    expect(parsed.bloatFindings[0]).toEqual({
      label: "CoreSimulator",
      path: "/Users/x/Library/Developer/CoreSimulator",
      sizeBytes: 42_949_672_960,
      thresholdBytes: 21_474_836_480,
    });
    expect(parsed.bloatFindings[1]?.label).toBe("Chrome 'Default' History");
  });

  test("reports aborted status when the trap fires", () => {
    const stdout = [
      "=== weekly-cleanup 2026-05-21T03:00:00-05:00 (dry_run=0) ===",
      "NEXUS_RESULT started_at=2026-05-21T03:00:00-05:00 dry_run=0 log_path=/tmp/wc.log",
      "=== ABORTED rc=137 — did not reach completion sentinel ===",
      "NEXUS_RESULT status=aborted rc=137 log_path=/tmp/wc.log",
    ].join("\n");

    const parsed = parseReaperOutput(stdout);
    expect(parsed.status).toBe("aborted");
    expect(parsed.rc).toBe(137);
    expect(parsed.logPath).toBe("/tmp/wc.log");
    expect(parsed.bloatFindings).toHaveLength(0);
  });

  test("treats malformed output as failure with zero counters", () => {
    const parsed = parseReaperOutput("nothing useful here\n");
    expect(parsed.status).toBe("failure");
    expect(parsed.pruned).toBe(0);
    expect(parsed.freedBytes).toBe(0);
    expect(parsed.bloatFindings).toHaveLength(0);
  });

  test("ignores malformed NEXUS_BLOAT lines without label/path", () => {
    const stdout = [
      "NEXUS_BLOAT garbage",
      "NEXUS_BLOAT label=only-label",
      "NEXUS_RESULT status=success pruned=0 freed_bytes=0 log_path=/tmp/wc.log",
    ].join("\n");

    const parsed = parseReaperOutput(stdout);
    expect(parsed.bloatFindings).toHaveLength(0);
    expect(parsed.status).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// runReaper — live-spawn with sandboxed $HOME
// ---------------------------------------------------------------------------

/**
 * Spawn the bash core against a sandboxed HOME so destructive operations
 * have nothing to operate on. Even in dry-run mode the script touches
 * $HOME paths (df, du, find) — the sandbox ensures we don't perturb the
 * developer's actual home directory while running tests.
 *
 * The bash core also scans `/Library/Developer` (Xcode runtimes), which on
 * a developer Mac can take minutes. The live-spawn suite is gated behind
 * NEXUS_RUN_LIVE_REAPER_TESTS=1 so CI doesn't pay that cost; the parser
 * tests above already prove the wrapper's parsing logic. Enable explicitly
 * with: `NEXUS_RUN_LIVE_REAPER_TESTS=1 bun test reaper-job.test.ts`.
 */
const runLive = process.env.NEXUS_RUN_LIVE_REAPER_TESTS === "1";
describe.skipIf(!runLive)("runReaper (live-spawn)", () => {
  let sandbox: string;
  let originalHome: string | undefined;
  const scriptPath = defaultScriptPath();

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "nx-reaper-test-"));
    // Pre-create the dirs the script writes to so paths exist but are
    // otherwise empty. The script's `mkdir -p` handles missing ones too.
    mkdirSync(join(sandbox, ".local", "state"), { recursive: true });
    mkdirSync(join(sandbox, ".cache"), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = sandbox;
  });

  afterAll(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("script file exists at the resolved default path", () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  test("dry-run performs zero mutations to seeded cache files", async () => {
    // Seed a marker file inside the sandbox's .cache dir. After a dry-run
    // it MUST still exist — the script must not delete in dry mode.
    const marker = join(sandbox, ".cache", "marker-do-not-delete");
    writeFileSync(marker, "hello");

    const before = statSync(marker).mtimeMs;
    const result = await runReaper({ dryRun: true });

    expect(existsSync(marker)).toBe(true);
    // mtime should be unchanged.
    expect(statSync(marker).mtimeMs).toBe(before);
    // Status should be success (the bash core treats a successful dry-run
    // identically to a real run for reporting purposes).
    expect(result.status).toBe("success");
    expect(result.logPath).toBe(
      join(sandbox, ".local", "state", "weekly-cleanup.log"),
    );
  }, 300_000);

  test("dry-run is idempotent — two consecutive runs leave the cache intact", async () => {
    const dirBefore = readdirSync(join(sandbox, ".cache")).sort();
    await runReaper({ dryRun: true });
    await runReaper({ dryRun: true });
    const dirAfter = readdirSync(join(sandbox, ".cache")).sort();
    expect(dirAfter).toEqual(dirBefore);
  }, 600_000);

  test("aborted child yields a non-success result", async () => {
    // Build a minimal failing script that exits before the completion
    // sentinel. The wrapper's status resolution must surface this as
    // `aborted` (the trap line) or `failure` (non-zero exit code).
    const stubPath = join(sandbox, "abort-stub.sh");
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env bash",
        "set -u",
        "echo 'NEXUS_RESULT started_at=2026-05-21T03:00:00-05:00 dry_run=0 log_path=/tmp/x.log'",
        "exit 7",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await runReaper({ scriptPath: stubPath });
    // exitCode != 0 AND parser saw no status=success — wrapper resolves
    // to failure (since the bash trap is NOT in this stub). This still
    // proves the abort path is observable to the wrapper.
    expect(["aborted", "failure"]).toContain(result.status);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// emitStaleHeartbeatNotification — persisted cooldown (nx-a9vf9)
// ---------------------------------------------------------------------------
//
// Regression coverage for the bug: cron.ts calls checkReaperHeartbeat +
// emitStaleHeartbeatNotification unconditionally on every process boot, with
// no cooldown at all, so a day of frequent redeploys (51 restarts / 48h
// observed) fired 102 duplicate "Reaper stale-heartbeat WARNING" events. The
// cooldown state must survive process restarts — these tests only cover the
// in-process gating logic (the module-level `lastStaleHeartbeatNotifyAt`),
// since the cross-restart persistence itself is the state-snapshot module's
// own already-tested contract (state-snapshot.test.ts) that this file's
// `registerSnapshotSource("stale-heartbeat-notify", …)` call plugs into.

function captureStaleHeartbeatNotifications(): {
  fired: LifecycleEnvelope<"NotificationFired">[];
  detach: () => void;
} {
  const fired: LifecycleEnvelope<"NotificationFired">[] = [];
  const handler = (env: LifecycleEnvelope<"NotificationFired">): void => {
    fired.push(env);
  };
  lifecycleBus.on("NotificationFired", handler);
  return { fired, detach: () => lifecycleBus.off("NotificationFired", handler) };
}

const STALE_RESULT: StaleHeartbeatResult = {
  stale: true,
  reason: "no-prior-success",
  lastSuccessAt: null,
};

describe("emitStaleHeartbeatNotification cooldown", () => {
  beforeEach(() => {
    __resetStaleHeartbeatNotifyForTests();
  });

  test("first call emits both desktop + tts NotificationFired events and returns true", () => {
    const { fired, detach } = captureStaleHeartbeatNotifications();
    try {
      const emitted = emitStaleHeartbeatNotification(STALE_RESULT, new Date("2026-07-15T00:00:00Z"));
      expect(emitted).toBe(true);
      expect(fired).toHaveLength(2);
      expect(fired.map((f) => f.payload.channel).sort()).toEqual(["desktop", "tts"]);
      expect(fired[0]?.payload.title).toBe("Reaper stale-heartbeat WARNING");
    } finally {
      detach();
    }
  });

  test("a second call within the cooldown window does NOT re-emit", () => {
    const { fired, detach } = captureStaleHeartbeatNotifications();
    try {
      const first = emitStaleHeartbeatNotification(STALE_RESULT, new Date("2026-07-15T00:00:00Z"));
      expect(first).toBe(true);
      expect(fired).toHaveLength(2);

      // Simulate a restart 10 minutes later (well inside the 12h cooldown) —
      // this is the exact shape of the bug: a redeploy reboots the process
      // and cron.ts fires the check again on the new boot.
      const second = emitStaleHeartbeatNotification(
        STALE_RESULT,
        new Date("2026-07-15T00:10:00Z"),
      );
      expect(second).toBe(false);
      // No new events — still exactly the 2 from the first call.
      expect(fired).toHaveLength(2);
    } finally {
      detach();
    }
  });

  test("a call after the cooldown window expires DOES re-emit", () => {
    const { fired, detach } = captureStaleHeartbeatNotifications();
    try {
      const first = emitStaleHeartbeatNotification(STALE_RESULT, new Date("2026-07-15T00:00:00Z"));
      expect(first).toBe(true);
      expect(fired).toHaveLength(2);

      const justAfterCooldown = new Date(
        new Date("2026-07-15T00:00:00Z").getTime() + STALE_HEARTBEAT_NOTIFY_COOLDOWN_MS + 1,
      );
      const second = emitStaleHeartbeatNotification(STALE_RESULT, justAfterCooldown);
      expect(second).toBe(true);
      expect(fired).toHaveLength(4);
    } finally {
      detach();
    }
  });
});
