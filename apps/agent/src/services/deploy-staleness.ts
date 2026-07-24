/**
 * deploy-staleness — weekly cron job that detects remote agents whose
 * deployed `HEAD` has drifted from the local machine's `HEAD`.
 *
 * Spec: openspec/changes/nexus-self-healing-infra (remote-deploy-fanout
 * capability).
 *
 * Reuses `deploy/lib/remote-agents.sh`'s `get_remote_agents` (task 2.4 — the
 * same parser `deploy/hooks.d/post-merge/02-deploy` sources for its own SSH
 * fan-out) rather than re-implementing agents.toml parsing in TS, so the
 * "who counts as a remote" definition never drifts between the deploy hook
 * and this detector.
 *
 * Staleness bookkeeping mirrors `reaper-job.ts`'s
 * `checkReaperHeartbeat`/`emitStaleHeartbeatNotification` shape closely:
 *   - A cooldown constant + a single `lastNotifyAt` epoch-ms guard,
 *     persisted via `state-snapshot` so a restart doesn't reset the cooldown.
 *   - Detection reads persisted history (here: the previous `cron_runs` row
 *     for this job) rather than in-memory-only state, so restarts don't lose
 *     track of how long a remote has been mismatched.
 */

import { join } from "node:path";
import { createLogger, getAgentsConfigPath } from "@nexus/core/node";
import type { Db, NewCronRun } from "@nexus/db";
import { cronRuns } from "@nexus/db";
import { execText } from "../utils/exec";
import { lifecycleBus } from "./lifecycle-bus";
import type { NotificationFiredPayload } from "./lifecycle-bus";
import { resolveRepoRoot } from "../routes/wave-plans";
import { registerSnapshotSource } from "./state-snapshot";
import { getNotificationManager } from "../routes/notifications";

const log = createLogger("agent:deploy-staleness");

/**
 * Route a deploy-staleness notification through the shared
 * `NotificationManager` singleton (`sendServiceNotification`) so the same
 * meeting-hold/presence/quiet-hours gating HTTP-originated notifications get
 * applies here too (route-service-notifications-through-manager). Falls back
 * to the legacy direct `lifecycleBus.emit` when no manager is available yet
 * or the manager pathway rejects — never drops a notification.
 */
function routeServiceNotification(payload: NotificationFiredPayload): void {
  const manager = getNotificationManager();
  if (!manager) {
    lifecycleBus.emit("NotificationFired", payload);
    return;
  }
  manager.sendServiceNotification(payload).catch((err) => {
    log.warn(
      { id: payload.id, err: err instanceof Error ? err.message : String(err) },
      "deploy-staleness: sendServiceNotification failed — falling back to lifecycle bus",
    );
    lifecycleBus.emit("NotificationFired", payload);
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemoteAgent {
  /** `user@host` — the SSH target, as emitted by `get_remote_agents`. */
  target: string;
  /** Remote checkout path (defaults to `~/dev/nx` inside the bash parser). */
  repoDir: string;
}

export interface RemoteDeployStatus {
  target: string;
  repoDir: string;
  reachable: boolean;
  remoteHead: string | null;
  inSync: boolean;
  /**
   * ISO-8601 timestamp of when this remote's HEAD first diverged from local,
   * continuously. Carried forward from the previous `cron_runs` row across
   * runs so staleness age survives an agent restart. `null` when in sync, or
   * when a never-mismatched remote is currently unreachable.
   */
  mismatchSince: string | null;
  error?: string;
}

export interface DeployStalenessResult {
  status: "success" | "failure";
  localHead: string | null;
  remotes: RemoteDeployStatus[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** A remote is "stale" once its HEAD has continuously mismatched for this long. */
export const DEPLOY_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Cooldown between deploy-staleness notifications — same 12h shape as
 * `reaper-job.ts`'s `STALE_HEARTBEAT_NOTIFY_COOLDOWN_MS`, for the same
 * reason: a frequent-redeploy day (or a flapping remote) must not turn into
 * dozens of duplicate "still stale" notifications, while still re-alerting
 * a few times a day during a genuine multi-day outage.
 */
export const DEPLOY_STALENESS_NOTIFY_COOLDOWN_MS = 12 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Remote enumeration (deploy/lib/remote-agents.sh)
// ---------------------------------------------------------------------------

/** Absolute path to the vendored `get_remote_agents` bash lib. */
export function defaultRemoteAgentsScriptPath(): string {
  return join(resolveRepoRoot(), "deploy", "lib", "remote-agents.sh");
}

/**
 * Parse `get_remote_agents`'s tab-separated `target\trepo_dir` stdout.
 * Exported for unit tests.
 */
export function parseRemoteAgentsOutput(stdout: string): RemoteAgent[] {
  const agents: RemoteAgent[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const [target = "", repoDir = "~/dev/nx"] = line.split("\t");
    if (!target) continue;
    agents.push({ target, repoDir: repoDir || "~/dev/nx" });
  }
  return agents;
}

export interface GetRemoteAgentsOptions {
  /** Override the script path — used by tests. */
  scriptPath?: string;
  /** Override the agents.toml path — used by tests. */
  configPath?: string;
  /** Override `bash` binary — used by tests. */
  bashBin?: string;
}

/**
 * Source `deploy/lib/remote-agents.sh` and invoke `get_remote_agents` over
 * the configured agents.toml. Never throws on a missing/empty config — the
 * bash function itself no-ops (empty stdout) when the file is absent.
 */
export async function getRemoteAgents(
  opts: GetRemoteAgentsOptions = {},
): Promise<RemoteAgent[]> {
  const scriptPath = opts.scriptPath ?? defaultRemoteAgentsScriptPath();
  const configPath = opts.configPath ?? getAgentsConfigPath();
  const bashBin = opts.bashBin ?? "bash";

  const stdout = await execText(
    bashBin,
    ["-c", `source "${scriptPath}" && get_remote_agents "${configPath}"`],
    { trustArgs: true },
  );
  return parseRemoteAgentsOutput(stdout);
}

// ---------------------------------------------------------------------------
// HEAD comparison
// ---------------------------------------------------------------------------

/** `git rev-parse HEAD` on the local checkout. Exported for unit tests. */
export async function getLocalHead(repoRoot: string): Promise<string> {
  const out = await execText("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return out.trim();
}

export interface GetRemoteHeadOptions {
  /** Override `ssh` binary — used by tests. */
  sshBin?: string;
  /** Per-remote exec timeout (ssh's own ConnectTimeout is separate/shorter). */
  timeoutMs?: number;
}

/**
 * SSH into a remote and read `git rev-parse HEAD` at its deployed checkout.
 * `repoDir`/`target` are sourced from the locally-trusted agents.toml (via
 * `get_remote_agents`), not network input — same trust boundary the
 * existing `02-deploy` fan-out already relies on for its own `cd $repo_dir
 * && ...` SSH command, so `trustArgs` here is not a new exposure.
 */
export async function getRemoteHead(
  remote: RemoteAgent,
  opts: GetRemoteHeadOptions = {},
): Promise<string> {
  const sshBin = opts.sshBin ?? "ssh";
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const out = await execText(
    sshBin,
    [
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      remote.target,
      `cd ${remote.repoDir} && git rev-parse HEAD`,
    ],
    { timeout: timeoutMs, trustArgs: true },
  );
  return out.trim();
}

// ---------------------------------------------------------------------------
// Staleness bookkeeping (pure — exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Resolve the `mismatchSince` carry-forward value for one remote.
 *
 * - In sync -> `null` (no mismatch).
 * - Mismatched, no prior mismatch on record -> `now` (mismatch starts here).
 * - Mismatched, prior mismatch on record -> the prior value (continuous).
 * - Unreachable -> carry forward whatever was on record (unknown, not reset).
 */
export function resolveMismatchSince(
  inSync: boolean,
  reachable: boolean,
  priorMismatchSince: string | null,
  now: Date,
): string | null {
  if (!reachable) return priorMismatchSince;
  if (inSync) return null;
  return priorMismatchSince ?? now.toISOString();
}

/** Whether a remote has been continuously mismatched for over the threshold. */
export function isRemoteStale(mismatchSince: string | null, now: Date): boolean {
  if (!mismatchSince) return false;
  return now.getTime() - Date.parse(mismatchSince) > DEPLOY_STALE_THRESHOLD_MS;
}

/**
 * Check one remote's deploy status against `localHead`. Never throws — an
 * SSH failure (timeout, unreachable host, non-zero exit) is caught and
 * surfaced as `reachable: false` so the caller can continue to the next
 * remote instead of aborting the whole job.
 */
export async function checkRemoteDeployStatus(
  remote: RemoteAgent,
  localHead: string,
  priorStatus: RemoteDeployStatus | undefined,
  opts: GetRemoteHeadOptions = {},
  now: Date = new Date(),
): Promise<RemoteDeployStatus> {
  const priorMismatchSince = priorStatus?.mismatchSince ?? null;

  try {
    const remoteHead = await getRemoteHead(remote, opts);
    const inSync = remoteHead === localHead;
    return {
      target: remote.target,
      repoDir: remote.repoDir,
      reachable: true,
      remoteHead,
      inSync,
      mismatchSince: resolveMismatchSince(inSync, true, priorMismatchSince, now),
    };
  } catch (err) {
    log.warn(
      {
        target: remote.target,
        error: err instanceof Error ? err.message : String(err),
      },
      "deploy-staleness: remote unreachable — continuing to next remote",
    );
    return {
      target: remote.target,
      repoDir: remote.repoDir,
      reachable: false,
      remoteHead: null,
      inSync: false,
      mismatchSince: resolveMismatchSince(false, false, priorMismatchSince, now),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface PersistDeployStalenessOpts {
  db: Db;
  result: DeployStalenessResult;
  /** Defaults to `new Date()` — overridable for deterministic tests. */
  timestamp?: Date;
}

export async function persistDeployStalenessResult(
  opts: PersistDeployStalenessOpts,
): Promise<{ cronRunId: number }> {
  const { db, result } = opts;
  const timestamp = opts.timestamp ?? new Date();

  const detailsJson = {
    localHead: result.localHead,
    remotes: result.remotes,
    error: result.error,
  };
  const metricsJson = {
    remoteCount: result.remotes.length,
    unreachableCount: result.remotes.filter((r) => !r.reachable).length,
    staleCount: result.remotes.filter((r) => isRemoteStale(r.mismatchSince, timestamp))
      .length,
  };

  const newRow: NewCronRun = {
    timestamp,
    job: "deploy-staleness",
    status: result.status,
    details: detailsJson,
    metrics: metricsJson,
  };

  const [inserted] = await db.insert(cronRuns).values(newRow).returning({ id: cronRuns.id });
  if (!inserted) {
    throw new Error("cronRuns insert returned no rows");
  }

  log.info(
    { cronRunId: inserted.id, status: result.status, remoteCount: result.remotes.length },
    "deploy-staleness: persisted run",
  );

  return { cronRunId: inserted.id };
}

/** Load the previous `deploy-staleness` cron_runs row's per-remote statuses, keyed by target. */
async function loadPriorStatuses(db: Db): Promise<Map<string, RemoteDeployStatus>> {
  const priorByTarget = new Map<string, RemoteDeployStatus>();
  try {
    const priorRow = await db.query.cronRuns.findFirst({
      where: (cr, { eq }) => eq(cr.job, "deploy-staleness"),
      orderBy: (cr, { desc }) => [desc(cr.timestamp)],
    });
    const details = priorRow?.details as { remotes?: RemoteDeployStatus[] } | null | undefined;
    if (details && Array.isArray(details.remotes)) {
      for (const r of details.remotes) {
        if (r && typeof r.target === "string") priorByTarget.set(r.target, r);
      }
    }
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "deploy-staleness: failed to read prior run (treating as no prior state)",
    );
  }
  return priorByTarget;
}

// ---------------------------------------------------------------------------
// Notification emission
// ---------------------------------------------------------------------------

let lastDeployStalenessNotifyAt: number | null = null;

registerSnapshotSource("deploy-staleness-notify", {
  serialize: () => lastDeployStalenessNotifyAt,
  deserialize: (data) => {
    lastDeployStalenessNotifyAt = typeof data === "number" ? data : null;
  },
});

/** Test-only: reset cooldown state between cases. */
export function __resetDeployStalenessNotifyForTests(): void {
  lastDeployStalenessNotifyAt = null;
}

/**
 * Emit a deploy-staleness warning for every remote that has crossed
 * `DEPLOY_STALE_THRESHOLD_MS`, gated by `DEPLOY_STALENESS_NOTIFY_COOLDOWN_MS`
 * (single global cooldown, mirroring `emitStaleHeartbeatNotification`).
 * Returns `true` when the notification was actually emitted, `false` when
 * suppressed by an active cooldown.
 */
export function emitDeployStalenessNotification(
  staleRemotes: RemoteDeployStatus[],
  localHead: string | null,
  now: Date = new Date(),
): boolean {
  if (staleRemotes.length === 0) return false;

  const nowMs = now.getTime();
  if (
    lastDeployStalenessNotifyAt !== null &&
    nowMs - lastDeployStalenessNotifyAt < DEPLOY_STALENESS_NOTIFY_COOLDOWN_MS
  ) {
    log.debug(
      {
        lastNotifyAt: new Date(lastDeployStalenessNotifyAt).toISOString(),
        cooldownMs: DEPLOY_STALENESS_NOTIFY_COOLDOWN_MS,
      },
      "deploy-staleness: notification suppressed (cooldown active)",
    );
    return false;
  }
  lastDeployStalenessNotifyAt = nowMs;

  const localShort = localHead ? localHead.slice(0, 7) : "unknown";
  const items = staleRemotes.map((r) => {
    const ageHours = r.mismatchSince
      ? Math.round((nowMs - Date.parse(r.mismatchSince)) / (60 * 60 * 1000))
      : 0;
    const remoteShort = r.remoteHead ? r.remoteHead.slice(0, 7) : "unknown";
    return `${r.target}: stale ${ageHours}h (local ${localShort} vs remote ${remoteShort})`;
  });

  const body = `Remote deploy drift — ${items.join("; ")}.`;

  routeServiceNotification({
    id: `deploy-staleness-${Date.now()}`,
    title: "Deploy staleness WARNING",
    body,
    channel: "desktop",
    message: body,
    items,
  });

  routeServiceNotification({
    id: `deploy-staleness-tts-${Date.now()}`,
    title: "Deploy staleness WARNING",
    body,
    channel: "tts",
    message: body,
    items,
  });

  return true;
}

// ---------------------------------------------------------------------------
// Public orchestration entrypoint
// ---------------------------------------------------------------------------

export interface RunDeployStalenessOpts {
  db: Db;
  /** Defaults to `resolveRepoRoot()` — overridable for tests. */
  repoRoot?: string;
  /** Defaults to `new Date()` — overridable for tests. */
  timestamp?: Date;
  /** Skip lifecycle-bus emit (e.g. during ad-hoc / dry-run smoke tests). */
  suppressNotifications?: boolean;
  remoteAgentsOpts?: GetRemoteAgentsOptions;
  sshOpts?: GetRemoteHeadOptions;
}

/**
 * High-level entrypoint used by `cron.ts`: enumerate remotes, compare each
 * against local HEAD, persist the result, and emit the staleness
 * notification (if any). Never throws — a top-level failure (e.g. local
 * `git rev-parse` failing, or the bash parser erroring) is caught and
 * persisted as `status: "failure"` so the cron service's own outer try/catch
 * is a pure backstop, not the only thing standing between this job and a
 * cron-service crash.
 */
export async function runAndPersistDeployStaleness(
  opts: RunDeployStalenessOpts,
): Promise<DeployStalenessResult> {
  const { db } = opts;
  const now = opts.timestamp ?? new Date();
  const repoRoot = opts.repoRoot ?? resolveRepoRoot();

  let result: DeployStalenessResult;
  try {
    const localHead = await getLocalHead(repoRoot);
    const remotes = await getRemoteAgents(opts.remoteAgentsOpts);
    const priorByTarget = await loadPriorStatuses(db);

    const statuses: RemoteDeployStatus[] = [];
    for (const remote of remotes) {
      const status = await checkRemoteDeployStatus(
        remote,
        localHead,
        priorByTarget.get(remote.target),
        opts.sshOpts,
        now,
      );
      statuses.push(status);
    }

    result = { status: "success", localHead, remotes: statuses };
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err) },
      "deploy-staleness: check failed",
    );
    result = {
      status: "failure",
      localHead: null,
      remotes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    await persistDeployStalenessResult({ db, result, timestamp: now });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err) },
      "deploy-staleness: persist failed (continuing to notification emit)",
    );
  }

  if (!opts.suppressNotifications) {
    const stale = result.remotes.filter((r) => isRemoteStale(r.mismatchSince, now));
    if (stale.length > 0) {
      emitDeployStalenessNotification(stale, result.localHead, now);
    }
  }

  return result;
}
