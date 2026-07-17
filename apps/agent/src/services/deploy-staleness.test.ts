/**
 * deploy-staleness unit tests (nexus-self-healing-infra, remote-deploy-fanout
 * spec, task 3.4).
 *
 * Covers exactly the four contracts named in tasks.md 3.4, all DB-free (none
 * of `checkRemoteDeployStatus`/`resolveMismatchSince`/`isRemoteStale`/
 * `emitDeployStalenessNotification` touch the database — persistence lives
 * in `persistDeployStalenessResult`/`loadPriorStatuses`, out of scope here):
 *
 *   1. HEAD-comparison logic       -> `checkRemoteDeployStatus` in-sync /
 *      mismatched branches, driven by a fake `ssh` binary shadowing
 *      `getRemoteHead`'s subprocess call (same `sshBin` override seam
 *      `GetRemoteHeadOptions` exposes for exactly this purpose).
 *   2. 24h staleness threshold     -> `isRemoteStale` pure-function boundary.
 *   3. 12h notification cooldown  -> `emitDeployStalenessNotification`,
 *      mirroring `reaper-job.test.ts`'s
 *      `emitStaleHeartbeatNotification` cooldown suite shape exactly
 *      (lifecycleBus capture helper + `__reset...ForTests()` in beforeEach).
 *   4. Unreachable remote          -> `checkRemoteDeployStatus` catch path:
 *      logs and continues (`reachable: false` + populated `error`), never
 *      throws.
 *
 * The fake `ssh` is a real executable (not a mock.module) because
 * `getRemoteHead` calls `execText("ssh", ...)` through `safeSpawn`, which
 * enforces a binary allowlist by basename (`packages/core/src/safe-spawn.ts`)
 * — `ssh` is on that allowlist, so a same-named stub at an arbitrary path
 * passes the basename check and is spawned for real, deterministically and
 * instantly (no real network / real remote host involved).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkRemoteDeployStatus,
  resolveMismatchSince,
  isRemoteStale,
  emitDeployStalenessNotification,
  __resetDeployStalenessNotifyForTests,
  DEPLOY_STALE_THRESHOLD_MS,
  DEPLOY_STALENESS_NOTIFY_COOLDOWN_MS,
  type RemoteAgent,
  type RemoteDeployStatus,
} from "./deploy-staleness";
import { lifecycleBus, type LifecycleEnvelope } from "./lifecycle-bus";

// ---------------------------------------------------------------------------
// Fake `ssh` binary — shadows the real subprocess call so
// checkRemoteDeployStatus/getRemoteHead can be exercised without a real SSH
// connection or remote host.
// ---------------------------------------------------------------------------

let sshDir: string;

// safeSpawn's binary allowlist (packages/core/src/safe-spawn.ts) matches on
// BASENAME, so each fake stub must literally be named "ssh" — each variant
// therefore gets its own subdirectory to avoid colliding on that filename.

/** Write a fake `ssh` that always succeeds, echoing `head` as its stdout. */
function fakeSshSucceeding(head: string): string {
  const dir = mkdtempSync(join(sshDir, "ok-"));
  const scriptPath = join(dir, "ssh");
  writeFileSync(scriptPath, `#!/usr/bin/env bash\necho "${head}"\nexit 0\n`, { mode: 0o755 });
  return scriptPath;
}

/** Write a fake `ssh` that always fails (simulates an unreachable remote). */
function fakeSshFailing(): string {
  const dir = mkdtempSync(join(sshDir, "fail-"));
  const scriptPath = join(dir, "ssh");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash\necho "ssh: connect to host test-remote port 22: Connection refused" >&2\nexit 255\n`,
    { mode: 0o755 },
  );
  return scriptPath;
}

beforeEach(() => {
  sshDir = mkdtempSync(join(tmpdir(), "nx-deploy-staleness-ssh-"));
});

afterEach(() => {
  rmSync(sshDir, { recursive: true, force: true });
});

const REMOTE: RemoteAgent = { target: "test-remote@100.0.0.1", repoDir: "~/dev/nx" };
const LOCAL_HEAD = "abc123def4560000000000000000000000000000";

// ---------------------------------------------------------------------------
// 1. HEAD-comparison logic (checkRemoteDeployStatus, reachable branches)
// ---------------------------------------------------------------------------

describe("checkRemoteDeployStatus — HEAD comparison", () => {
  it("reports inSync=true and mismatchSince=null when remote HEAD matches local HEAD", async () => {
    const sshBin = fakeSshSucceeding(LOCAL_HEAD);

    const status = await checkRemoteDeployStatus(REMOTE, LOCAL_HEAD, undefined, { sshBin });

    expect(status.reachable).toBe(true);
    expect(status.remoteHead).toBe(LOCAL_HEAD);
    expect(status.inSync).toBe(true);
    expect(status.mismatchSince).toBeNull();
    expect(status.error).toBeUndefined();
  });

  it("reports inSync=false and sets mismatchSince=now when remote HEAD diverges with no prior mismatch on record", async () => {
    const remoteHead = "deadbeef0000000000000000000000000000000";
    const sshBin = fakeSshSucceeding(remoteHead);
    const now = new Date("2026-07-16T12:00:00Z");

    const status = await checkRemoteDeployStatus(REMOTE, LOCAL_HEAD, undefined, { sshBin }, now);

    expect(status.reachable).toBe(true);
    expect(status.remoteHead).toBe(remoteHead);
    expect(status.inSync).toBe(false);
    expect(status.mismatchSince).toBe(now.toISOString());
  });

  it("carries forward the prior mismatchSince across a continuously-mismatched run", async () => {
    const remoteHead = "deadbeef0000000000000000000000000000000";
    const sshBin = fakeSshSucceeding(remoteHead);
    const priorStatus: RemoteDeployStatus = {
      target: REMOTE.target,
      repoDir: REMOTE.repoDir,
      reachable: true,
      remoteHead,
      inSync: false,
      mismatchSince: "2026-07-14T00:00:00.000Z",
    };
    const now = new Date("2026-07-16T12:00:00Z");

    const status = await checkRemoteDeployStatus(REMOTE, LOCAL_HEAD, priorStatus, { sshBin }, now);

    expect(status.inSync).toBe(false);
    expect(status.mismatchSince).toBe("2026-07-14T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// 4. Unreachable remote — logs and continues, never throws
// ---------------------------------------------------------------------------

describe("checkRemoteDeployStatus — unreachable remote", () => {
  it("resolves (does not throw) with reachable=false and a populated error when SSH fails", async () => {
    const sshBin = fakeSshFailing();

    let status: RemoteDeployStatus | undefined;
    await expect(
      (async () => {
        status = await checkRemoteDeployStatus(REMOTE, LOCAL_HEAD, undefined, { sshBin });
      })(),
    ).resolves.toBeUndefined();

    expect(status).toBeDefined();
    expect(status?.reachable).toBe(false);
    expect(status?.remoteHead).toBeNull();
    expect(status?.inSync).toBe(false);
    expect(status?.error).toBeTruthy();
  });

  it("carries forward the prior mismatchSince (unknown, not reset) when the remote is unreachable", async () => {
    const sshBin = fakeSshFailing();
    const priorStatus: RemoteDeployStatus = {
      target: REMOTE.target,
      repoDir: REMOTE.repoDir,
      reachable: true,
      remoteHead: "deadbeef0000000000000000000000000000000",
      inSync: false,
      mismatchSince: "2026-07-10T00:00:00.000Z",
    };

    const status = await checkRemoteDeployStatus(REMOTE, LOCAL_HEAD, priorStatus, { sshBin });

    expect(status.reachable).toBe(false);
    expect(status.mismatchSince).toBe("2026-07-10T00:00:00.000Z");
  });

  it("reports mismatchSince=null when a never-mismatched remote is currently unreachable", async () => {
    const sshBin = fakeSshFailing();

    const status = await checkRemoteDeployStatus(REMOTE, LOCAL_HEAD, undefined, { sshBin });

    expect(status.reachable).toBe(false);
    expect(status.mismatchSince).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. 24h staleness threshold (isRemoteStale)
// ---------------------------------------------------------------------------

describe("isRemoteStale", () => {
  const now = new Date("2026-07-16T12:00:00Z");

  it("is false when mismatchSince is null (in sync)", () => {
    expect(isRemoteStale(null, now)).toBe(false);
  });

  it("is false just under the 24h threshold", () => {
    const mismatchSince = new Date(now.getTime() - DEPLOY_STALE_THRESHOLD_MS + 1000).toISOString();
    expect(isRemoteStale(mismatchSince, now)).toBe(false);
  });

  it("is true just over the 24h threshold", () => {
    const mismatchSince = new Date(now.getTime() - DEPLOY_STALE_THRESHOLD_MS - 1000).toISOString();
    expect(isRemoteStale(mismatchSince, now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveMismatchSince — the HEAD-comparison carry-forward logic in isolation
// ---------------------------------------------------------------------------

describe("resolveMismatchSince", () => {
  const now = new Date("2026-07-16T12:00:00Z");

  it("returns null when in sync, regardless of prior state", () => {
    expect(resolveMismatchSince(true, true, "2026-07-01T00:00:00Z", now)).toBeNull();
  });

  it("starts the clock at `now` on a fresh mismatch with no prior record", () => {
    expect(resolveMismatchSince(false, true, null, now)).toBe(now.toISOString());
  });

  it("carries forward the prior mismatch timestamp on a continuing mismatch", () => {
    expect(resolveMismatchSince(false, true, "2026-07-01T00:00:00Z", now)).toBe(
      "2026-07-01T00:00:00Z",
    );
  });

  it("carries forward whatever was on record (untouched) when unreachable", () => {
    expect(resolveMismatchSince(false, false, "2026-07-01T00:00:00Z", now)).toBe(
      "2026-07-01T00:00:00Z",
    );
    expect(resolveMismatchSince(true, false, null, now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. 12h notification cooldown (emitDeployStalenessNotification)
// ---------------------------------------------------------------------------

function captureDeployStalenessNotifications(): {
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

const STALE_REMOTE: RemoteDeployStatus = {
  target: "test-remote@100.0.0.1",
  repoDir: "~/dev/nx",
  reachable: true,
  remoteHead: "deadbeef0000000000000000000000000000000",
  inSync: false,
  mismatchSince: "2026-07-14T00:00:00.000Z",
};

describe("emitDeployStalenessNotification cooldown", () => {
  beforeEach(() => {
    __resetDeployStalenessNotifyForTests();
  });

  it("returns false and emits nothing when staleRemotes is empty", () => {
    const { fired, detach } = captureDeployStalenessNotifications();
    try {
      const emitted = emitDeployStalenessNotification([], LOCAL_HEAD, new Date("2026-07-16T00:00:00Z"));
      expect(emitted).toBe(false);
      expect(fired).toHaveLength(0);
    } finally {
      detach();
    }
  });

  it("first call emits both desktop + tts NotificationFired events and returns true", () => {
    const { fired, detach } = captureDeployStalenessNotifications();
    try {
      const emitted = emitDeployStalenessNotification(
        [STALE_REMOTE],
        LOCAL_HEAD,
        new Date("2026-07-16T00:00:00Z"),
      );
      expect(emitted).toBe(true);
      expect(fired).toHaveLength(2);
      expect(fired.map((f) => f.payload.channel).sort()).toEqual(["desktop", "tts"]);
      expect(fired[0]?.payload.title).toBe("Deploy staleness WARNING");
    } finally {
      detach();
    }
  });

  it("a second call within the 12h cooldown window does NOT re-emit", () => {
    const { fired, detach } = captureDeployStalenessNotifications();
    try {
      const first = emitDeployStalenessNotification(
        [STALE_REMOTE],
        LOCAL_HEAD,
        new Date("2026-07-16T00:00:00Z"),
      );
      expect(first).toBe(true);
      expect(fired).toHaveLength(2);

      const second = emitDeployStalenessNotification(
        [STALE_REMOTE],
        LOCAL_HEAD,
        new Date("2026-07-16T02:00:00Z"),
      );
      expect(second).toBe(false);
      expect(fired).toHaveLength(2);
    } finally {
      detach();
    }
  });

  it("a call after the 12h cooldown window expires DOES re-emit", () => {
    const { fired, detach } = captureDeployStalenessNotifications();
    try {
      const start = new Date("2026-07-16T00:00:00Z");
      const first = emitDeployStalenessNotification([STALE_REMOTE], LOCAL_HEAD, start);
      expect(first).toBe(true);
      expect(fired).toHaveLength(2);

      const justAfterCooldown = new Date(start.getTime() + DEPLOY_STALENESS_NOTIFY_COOLDOWN_MS + 1);
      const second = emitDeployStalenessNotification([STALE_REMOTE], LOCAL_HEAD, justAfterCooldown);
      expect(second).toBe(true);
      expect(fired).toHaveLength(4);
    } finally {
      detach();
    }
  });
});
