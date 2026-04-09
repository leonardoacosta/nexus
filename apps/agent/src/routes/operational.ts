/**
 * Operational routes — statusline, hooks, recommend, environment,
 * failures, cron.
 *
 * These are thin handlers that read from in-memory caches and service
 * state. They mirror the Rust agent's operational endpoints.
 */

import type { Db } from "@nexus/db";
import { createLogger } from "@nexus/core";
import os from "node:os";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { queryActiveSessions } from "../db/sessions";
import type { SessionRow } from "../db/sessions";
import { getCurrentMode } from "../services/command-handler";

const log = createLogger("agent:routes:operational");

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const startedAt = Date.now();

// ---------------------------------------------------------------------------
// GET /statusline
// ---------------------------------------------------------------------------

interface StatuslineSession {
  id: string;
  project: string | null;
  status: string;
  model: string | null;
  cwd: string | null;
  idle_seconds: number;
}

interface StatuslineGit {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

interface StatuslineMachine {
  cpu_percent: number;
  mem_percent: number;
  load_1m: number;
}

interface StatuslineResponse {
  sessions: StatuslineSession[];
  git: StatuslineGit | null;
  machine: StatuslineMachine;
  uptime_seconds: number;
  daemon_count: number;
}

// Git status cache (refreshes every 5 seconds).
let gitCache: { value: StatuslineGit | null; refreshedAt: number } = {
  value: null,
  refreshedAt: 0,
};
const GIT_CACHE_TTL_MS = 5_000;

async function getGitStatusCached(): Promise<StatuslineGit | null> {
  const now = Date.now();
  if (now - gitCache.refreshedAt < GIT_CACHE_TTL_MS) {
    return gitCache.value;
  }

  const result = await fetchGitStatus();
  gitCache = { value: result, refreshedAt: now };
  return result;
}

async function fetchGitStatus(): Promise<StatuslineGit | null> {
  try {
    const branchProc = Bun.spawn(["git", "branch", "--show-current"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const branchOut = await new Response(branchProc.stdout).text();
    const branchExit = await branchProc.exited;
    if (branchExit !== 0) return null;

    const branch = branchOut.trim();
    if (!branch) return null;

    const statusProc = Bun.spawn(["git", "status", "--porcelain"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const statusOut = await new Response(statusProc.stdout).text();
    await statusProc.exited;
    const dirty = statusOut.trim().length > 0;

    let ahead = 0;
    let behind = 0;
    try {
      const revProc = Bun.spawn(
        ["git", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        { stdout: "pipe", stderr: "ignore" },
      );
      const revOut = await new Response(revProc.stdout).text();
      const revExit = await revProc.exited;
      if (revExit === 0) {
        const parts = revOut.trim().split(/\s+/);
        if (parts.length === 2) {
          behind = parseInt(parts[0]!, 10) || 0;
          ahead = parseInt(parts[1]!, 10) || 0;
        }
      }
    } catch {
      // No upstream configured.
    }

    return { branch, dirty, ahead, behind };
  } catch {
    return null;
  }
}

export async function handleStatusline(db: Db): Promise<Response> {
  let sessions: SessionRow[] = [];
  try {
    sessions = await queryActiveSessions(db);
  } catch (err) {
    log.warn({ err }, "statusline: failed to query sessions");
  }

  const statuslineSessions: StatuslineSession[] = sessions.map((s) => ({
    id: s.id,
    project: s.project,
    status: s.status,
    model: null,
    cwd: s.cwd,
    idle_seconds: s.lastActivity
      ? Math.floor((Date.now() - s.lastActivity.getTime()) / 1000)
      : 0,
  }));

  const git = await getGitStatusCached();

  const loadAvg = os.loadavg();
  const machine: StatuslineMachine = {
    cpu_percent: 0,
    mem_percent: Math.round(
      ((os.totalmem() - os.freemem()) / os.totalmem()) * 100 * 10,
    ) / 10,
    load_1m: loadAvg[0] ?? 0,
  };

  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

  const response: StatuslineResponse = {
    sessions: statuslineSessions,
    git,
    machine,
    uptime_seconds: uptimeSeconds,
    daemon_count: statuslineSessions.length,
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// POST /hooks — receive CC session events via HTTP
// ---------------------------------------------------------------------------

interface HookEventPayload {
  hook_event_name?: string;
  event?: string;
  session_id?: string;
  project?: string;
  cwd?: string;
  model?: string;
  pid?: number;
  branch?: string;
  cc_session_id?: string;
  tmux_target?: string;
  tool_counts?: Record<string, number>;
  failure_count?: number;
  compaction_count?: number;
  agent_spawns?: number;
  duration_ms?: number;
  reason?: string;
}

export async function handleHooks(
  db: Db,
  request: Request,
): Promise<Response> {
  let payload: HookEventPayload;
  try {
    payload = (await request.json()) as HookEventPayload;
  } catch {
    return new Response(
      JSON.stringify({ status: "error", message: "invalid JSON" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const eventName =
    payload.hook_event_name ?? payload.event ?? "unknown";

  log.info({ event: eventName, sessionId: payload.session_id }, "hook event received");

  // For now, acknowledge all hook events. The socket dispatch layer
  // handles the actual session lifecycle management.
  switch (eventName) {
    case "session_start":
    case "session_stop":
    case "stop_failure":
    case "stop_success":
    case "session_summary":
    case "session_heartbeat":
      return new Response(
        JSON.stringify({ status: "ok", message: `${eventName} acknowledged` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    default:
      return new Response(
        JSON.stringify({
          status: "ok",
          message: `unknown event: ${eventName}`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
  }
}

// ---------------------------------------------------------------------------
// GET /recommend — next-action recommendation
// ---------------------------------------------------------------------------

interface Recommendation {
  id: string;
  title: string;
  score: number;
  reason: string;
  type: string;
}

interface RecommendContext {
  project: string;
  active_spec: string | null;
  session_count: number;
}

interface RecommendResponse {
  recommendations: Recommendation[];
  context: RecommendContext;
}

// Cache recommend results for 30 seconds.
let recommendCache: { value: RecommendResponse | null; refreshedAt: number } = {
  value: null,
  refreshedAt: 0,
};
const RECOMMEND_CACHE_TTL_MS = 30_000;

export async function handleRecommend(db: Db): Promise<Response> {
  let sessions: SessionRow[] = [];
  try {
    sessions = await queryActiveSessions(db);
  } catch {
    // Continue with empty session list.
  }

  const now = Date.now();
  if (
    now - recommendCache.refreshedAt < RECOMMEND_CACHE_TTL_MS &&
    recommendCache.value
  ) {
    // Update session count in cached response.
    recommendCache.value.context.session_count = sessions.length;
    return new Response(JSON.stringify(recommendCache.value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const response = await buildRecommendations(sessions.length);
  recommendCache = { value: response, refreshedAt: now };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function buildRecommendations(
  sessionCount: number,
): Promise<RecommendResponse> {
  const [bdReady, masterContext] = await Promise.all([
    fetchBdReady(),
    fetchMasterContext(),
  ]);

  const projectName = masterContext?.project?.name ?? masterContext?.project?.scope?.replace(/^@/, "") ?? "";
  const activeSpec = masterContext?.state?.active_spec || null;

  const recommendations: Recommendation[] = [];

  for (const item of bdReady) {
    let score = 0;
    const reasons: string[] = [];

    switch (item.priority) {
      case 0:
        score = 100;
        reasons.push("P0 broken");
        break;
      case 1:
        score = 80;
        reasons.push("P1 critical");
        break;
      case 2:
        score = 60;
        reasons.push(`P${item.priority} ${item.issue_type || "task"}`);
        break;
      case 3:
        score = 40;
        reasons.push(`P${item.priority} ${item.issue_type || "task"}`);
        break;
      default:
        score = 20;
        reasons.push(`P${item.priority} ${item.issue_type || "task"}`);
        break;
    }

    if (projectName) {
      const prefix = `${projectName}-`;
      if (item.id.startsWith(prefix)) {
        score += 25;
        reasons.push("same project");
      }
    }

    if (activeSpec && item.title.toLowerCase().includes(activeSpec.toLowerCase())) {
      score += 30;
      reasons.push("active spec");
    }

    if (item.created_at) {
      try {
        const created = new Date(item.created_at);
        const ageDays = (Date.now() - created.getTime()) / 86400_000;
        if (ageDays > 7) {
          score += 5;
          reasons.push("stale >7d");
        }
      } catch {
        // Ignore invalid dates.
      }
    }

    recommendations.push({
      id: item.id,
      title: item.title,
      score,
      reason: reasons.join(", "),
      type: item.issue_type || "task",
    });
  }

  recommendations.sort((a, b) => b.score - a.score);

  return {
    recommendations,
    context: {
      project: projectName,
      active_spec: activeSpec,
      session_count: sessionCount,
    },
  };
}

interface BdReadyItem {
  id: string;
  title: string;
  priority: number;
  issue_type: string;
  created_at: string;
}

async function fetchBdReady(): Promise<BdReadyItem[]> {
  try {
    const proc = Bun.spawn(["bd", "ready", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return [];

    const items = JSON.parse(stdout);
    if (!Array.isArray(items)) return [];
    return items as BdReadyItem[];
  } catch {
    return [];
  }
}

interface MasterContext {
  project?: { name?: string; scope?: string };
  state?: { active_spec?: string };
}

async function fetchMasterContext(): Promise<MasterContext | null> {
  const path = join(os.homedir(), ".claude/scripts/state/master-context.json");
  try {
    const contents = readFileSync(path, "utf8");
    return JSON.parse(contents) as MasterContext;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /environment — dependency, config, and service checks
// ---------------------------------------------------------------------------

interface DependencyCheck {
  found: boolean;
  version?: string;
  auth?: boolean;
}

interface EnvironmentResponse {
  status: string;
  checks: {
    dependencies: Record<string, DependencyCheck>;
    config: {
      settings_json: { valid: boolean; path: string };
      master_context: { exists: boolean; path: string };
      bin_dir: { exists: boolean; count: number };
    };
    services: {
      nexus_agent: { running: boolean; uptime_seconds: number };
      nexus_socket: { exists: boolean; path: string };
    };
  };
  timestamp: string;
}

// Cache for 60 seconds.
let envCache: { value: EnvironmentResponse | null; refreshedAt: number } = {
  value: null,
  refreshedAt: 0,
};
const ENV_CACHE_TTL_MS = 60_000;

export async function handleEnvironment(): Promise<Response> {
  const now = Date.now();
  const uptimeSeconds = Math.floor((now - startedAt) / 1000);

  if (now - envCache.refreshedAt < ENV_CACHE_TTL_MS && envCache.value) {
    // Update uptime and timestamp in cached copy.
    const cached = { ...envCache.value };
    cached.checks.services.nexus_agent.uptime_seconds = uptimeSeconds;
    cached.timestamp = new Date().toISOString();
    return new Response(JSON.stringify(cached), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const response = await collectEnvironment(uptimeSeconds);
  envCache = { value: response, refreshedAt: now };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function collectEnvironment(
  uptimeSeconds: number,
): Promise<EnvironmentResponse> {
  const home = os.homedir();

  // Check dependencies in parallel.
  const [bd, git, jq, node, cargo, gh, openspec] = await Promise.all([
    checkDependency("bd", ["--version"]),
    checkDependency("git", ["--version"]),
    checkDependency("jq", ["--version"]),
    checkDependency("node", ["--version"]),
    checkDependency("cargo", ["--version"]),
    checkGh(),
    checkDependency("openspec", ["--version"]),
  ]);

  const dependencies: Record<string, DependencyCheck> = {
    bd,
    git,
    jq,
    node,
    cargo,
    gh,
    openspec,
  };

  // Config checks.
  const settingsPath = join(home, ".claude/settings.json");
  const masterContextPath = join(home, ".claude/scripts/state/master-context.json");
  const binDirPath = join(home, ".claude/scripts/bin");

  let settingsValid = false;
  try {
    const contents = readFileSync(settingsPath, "utf8");
    JSON.parse(contents);
    settingsValid = true;
  } catch {
    // Invalid or missing.
  }

  const masterContextExists = existsSync(masterContextPath);

  let binDirExists = false;
  let binDirCount = 0;
  try {
    const entries = readdirSync(binDirPath);
    binDirExists = true;
    binDirCount = entries.length;
  } catch {
    // Missing.
  }

  // Service checks.
  const socketPath = "/tmp/nexus-agent.sock";
  const socketExists = existsSync(socketPath);

  const gitFound = dependencies.git?.found ?? false;
  const anyMissing = Object.values(dependencies).some((d) => !d.found);

  const status = !gitFound ? "critical" : anyMissing ? "degraded" : "healthy";

  return {
    status,
    checks: {
      dependencies,
      config: {
        settings_json: {
          valid: settingsValid,
          path: settingsPath.replace(home, "~"),
        },
        master_context: {
          exists: masterContextExists,
          path: masterContextPath.replace(home, "~"),
        },
        bin_dir: { exists: binDirExists, count: binDirCount },
      },
      services: {
        nexus_agent: { running: true, uptime_seconds: uptimeSeconds },
        nexus_socket: { exists: socketExists, path: socketPath },
      },
    },
    timestamp: new Date().toISOString(),
  };
}

async function checkDependency(
  name: string,
  versionArgs: string[],
): Promise<DependencyCheck> {
  try {
    const whichProc = Bun.spawn(["which", name], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const whichExit = await whichProc.exited;
    if (whichExit !== 0) {
      return { found: false };
    }

    const versionProc = Bun.spawn([name, ...versionArgs], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const versionOut = await new Response(versionProc.stdout).text();
    const versionExit = await versionProc.exited;

    const version =
      versionExit === 0 ? extractVersion(versionOut.trim()) : undefined;

    return { found: true, version };
  } catch {
    return { found: false };
  }
}

async function checkGh(): Promise<DependencyCheck> {
  const dep = await checkDependency("gh", ["--version"]);
  if (!dep.found) return dep;

  try {
    const authProc = Bun.spawn(["gh", "auth", "status"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const authExit = await authProc.exited;
    dep.auth = authExit === 0;
  } catch {
    dep.auth = false;
  }

  return dep;
}

function extractVersion(raw: string): string {
  const line = raw.split("\n")[0] ?? raw;

  for (const word of line.split(/\s+/)) {
    const trimmed = word.replace(/^v/, "").replace(/^jq-/, "");
    if (/^\d+\./.test(trimmed) && trimmed.includes(".")) {
      return trimmed;
    }
  }

  return line;
}

// ---------------------------------------------------------------------------
// GET /failures — aggregated tool failure data
// ---------------------------------------------------------------------------

export async function handleFailures(url: URL): Promise<Response> {
  const daysParam = url.searchParams.get("days");
  const days = daysParam ? parseInt(daysParam, 10) : 7;

  // The failure buffer is backed by the Rust agent's SQLite.
  // For now, return a stub response matching the expected shape.
  return new Response(
    JSON.stringify({
      period_days: days,
      total: 0,
      by_tool: {},
      by_project: {},
      top_errors: [],
      trend: {
        current: 0,
        previous: 0,
        direction: "flat",
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// GET /cron — cron job status and last run times
// ---------------------------------------------------------------------------

export function handleCron(): Response {
  // Return the known cron jobs and their schedules.
  // Actual last_run tracking is done by the CronService which runs in-process.
  return new Response(
    JSON.stringify({
      jobs: {
        maintain: {
          schedule: "daily @ 00:17",
          last_run: null,
          last_status: null,
          last_log: null,
        },
        drift: {
          schedule: "weekly @ Sun 09:00",
          last_run: null,
          last_status: null,
          last_log: null,
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
