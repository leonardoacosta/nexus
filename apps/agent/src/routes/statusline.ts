/**
 * GET /statusline — the single composed read-model for statusline / dashboard
 * consumers (redesign-status-usage-endpoints).
 *
 * Dispatches on the `sessionId` / `accountId` query params per design.md's
 * four-mode contract:
 *
 *   | sessionId | accountId | Response                                        |
 *   |-----------|-----------|-------------------------------------------------|
 *   | absent    | absent    | today's overview + `{ accounts: Account5H7D[] }`|
 *   | absent    | present   | `{ account: Account5H7D }` — one account (404)  |
 *   | present   | absent    | `{ session: SessionStatusResponse }` (404)      |
 *   | present   | present   | `400 { error: "...mutually exclusive" }`        |
 *
 * The neither-mode response is ADDITIVE: today's `sessions[]`/`git`/`machine`/
 * `uptime_seconds`/`daemon_count` fields are preserved unchanged, with the
 * account 5H/7D usage array carried alongside.
 *
 * Composition reuses pre-existing read paths — never a new live shell-out per
 * source:
 *   - account 5H/7D usage: the `credentials` table (written by the usage poller)
 *   - per-session cost usage: `readSessionCostTokens` (VictoriaMetrics)
 *   - per-session project status: `latestProjectStatus` (project_status_snapshots)
 *     + `getObservedGitState` (git-observer), resolved via
 *     `sessions.projectId -> projects.name`
 *   - next-action: `getRecommendation` (composed in-process, no HTTP round-trip)
 */

import type { Db } from "@nexus/db";
import { credentials, projects } from "@nexus/db";
import { eq } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";
import { modelFamilyLetter } from "@nexus/core";
import type {
  Account5H7D,
  NextRecommendation,
  SessionStatusResponse,
} from "@nexus/core";
import os from "node:os";
import { queryActiveSessions } from "../db/sessions";
import type { SessionRow } from "../db/sessions";
import { getSessionById } from "../db/sessions";
import { execText } from "../utils/exec";
import { createVmReadClient } from "../telemetry/vm-read";
import type { VmReadClient } from "../telemetry/vm-read";
import { readSessionCostTokens } from "../telemetry/session-cost-read";
import { latestProjectStatus } from "../services/status-snapshots";
import { getObservedGitState } from "../services/git-observer";
import { getRecommendation } from "./recommend";
import { getFreshContextEntry } from "./session-context";

const log = createLogger("agent:routes:statusline");

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Types (neither-mode overview — preserved unchanged, plus `accounts`)
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

interface StatuslineOverview {
  sessions: StatuslineSession[];
  git: StatuslineGit | null;
  machine: StatuslineMachine;
  uptime_seconds: number;
  daemon_count: number;
  /** Account 5H/7D usage for every known account (redesign-status-usage-endpoints). */
  accounts: Account5H7D[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A `credentials` row's usage columns — the subset this route reads. */
interface CredentialUsageRow {
  id: string;
  usage5hUsed: number | null;
  usage5hLimit: number | null;
  usage5hResetAt: Date | null;
  usage7dUsed: number | null;
  usage7dLimit: number | null;
  usage7dResetAt: Date | null;
}

/** Map a `credentials` row to the `Account5H7D` wire shape. */
function toAccount5H7D(row: CredentialUsageRow): Account5H7D {
  return {
    accountId: row.id,
    fiveHour: {
      used: row.usage5hUsed ?? 0,
      limit: row.usage5hLimit ?? 0,
      resetsAt: row.usage5hResetAt ? row.usage5hResetAt.toISOString() : null,
    },
    sevenDay: {
      used: row.usage7dUsed ?? 0,
      limit: row.usage7dLimit ?? 0,
      resetsAt: row.usage7dResetAt ? row.usage7dResetAt.toISOString() : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Git status cache (refreshes every 5 seconds)
// ---------------------------------------------------------------------------

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
    const branchOut = await execText("git", ["branch", "--show-current"]);
    const branch = branchOut.trim();
    if (!branch) return null;

    const statusOut = await execText("git", ["status", "--porcelain"]);
    const dirty = statusOut.trim().length > 0;

    let ahead = 0;
    let behind = 0;
    try {
      const revOut = await execText("git", [
        "rev-list", "--left-right", "--count", "@{upstream}...HEAD",
      ]);
      const parts = revOut.trim().split(/\s+/);
      if (parts.length === 2) {
        behind = parseInt(parts[0]!, 10) || 0;
        ahead = parseInt(parts[1]!, 10) || 0;
      }
    } catch {
      // No upstream configured.
    }

    return { branch, dirty, ahead, behind };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mode: accountId — one account's 5H/7D usage (404 if unknown)
// ---------------------------------------------------------------------------

async function buildAccountStatus(
  db: Db,
  accountId: string,
): Promise<Account5H7D | null> {
  const [row] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, accountId))
    .limit(1);
  if (!row) return null;
  return toAccount5H7D(row);
}

// ---------------------------------------------------------------------------
// Mode: sessionId — the composed single-session status (404 if unknown)
// ---------------------------------------------------------------------------

async function buildSessionStatus(
  db: Db,
  vm: VmReadClient,
  sessionId: string,
): Promise<SessionStatusResponse | null> {
  const session = await getSessionById(db, sessionId);
  if (!session) return null;

  const model = modelFamilyLetter({ id: session.model ?? undefined }) ?? null;

  // 5H/7D usage via the session's active credential (denormalized, not FK).
  let fiveHour: Account5H7D["fiveHour"] | null = null;
  let sevenDay: Account5H7D["sevenDay"] | null = null;
  if (session.credentialId) {
    const [cred] = await db
      .select()
      .from(credentials)
      .where(eq(credentials.id, session.credentialId))
      .limit(1);
    if (cred) {
      const acct = toAccount5H7D(cred);
      fiveHour = acct.fiveHour;
      sevenDay = acct.sevenDay;
    }
  }

  // Cost usage via VictoriaMetrics — disabled VM degrades to the zero/null
  // breakdown (never throws), mapped straight onto the wire `usage` shape.
  const cost = await readSessionCostTokens(vm, sessionId);
  const usage: SessionStatusResponse["usage"] = {
    cost_usd: cost.cost_usd,
    input: cost.input,
    output: cost.output,
    cache_read: cost.cache_read,
    cache_creation: cost.cache_creation,
  };

  // Project status via sessions.projectId -> projects.name -> latest snapshot
  // (+ observed git state). `null` when the session has no resolvable project.
  let project: SessionStatusResponse["project"] = null;
  if (session.projectId) {
    const [proj] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, session.projectId))
      .limit(1);
    if (proj) {
      const latest = await latestProjectStatus(db, proj.name);
      const git = getObservedGitState(proj.name) ?? null;
      project = {
        beadsReadyUnlinked: latest?.beadsReadyUnlinked ?? 0,
        beadsBlockedUnlinked: latest?.beadsBlockedUnlinked ?? 0,
        proposalsUnarchived: latest?.proposalsUnarchived ?? 0,
        git,
      };
    }
  }

  // Next-action recommendation, composed in-process (cached upstream).
  let next: NextRecommendation | null = null;
  try {
    next = await getRecommendation(db);
  } catch (err) {
    log.warn({ err, sessionId }, "statusline: recommendation compose failed");
  }

  // Context-window usage from the in-memory session-context store (populated by
  // process-hook-event's transcript collector). `null`/`null` when no fresh
  // entry exists — additive, degrades gracefully after an agent restart or for
  // a brand-new session with zero hook events yet. Single-sourced freshness
  // check via getFreshContextEntry.
  const ctx = getFreshContextEntry(sessionId);
  const usedPercentage = ctx?.usedPercentage ?? null;
  const contextWindowSize = ctx?.contextWindowSize ?? null;

  return {
    sessionId,
    model,
    fiveHour,
    sevenDay,
    usage,
    project,
    next,
    usedPercentage,
    contextWindowSize,
  };
}

// ---------------------------------------------------------------------------
// Mode: neither — today's overview (unchanged) + all-accounts usage
// ---------------------------------------------------------------------------

async function buildOverview(db: Db): Promise<StatuslineOverview> {
  let sessions: SessionRow[] = [];
  try {
    sessions = await queryActiveSessions(db);
  } catch (err) {
    log.warn({ err }, "statusline: failed to query sessions");
  }

  const statuslineSessions: StatuslineSession[] = sessions.map((s) => ({
    id: s.id,
    // NOTE: `sessions.project` (text name) was dropped in favor of `projectId`
    // (uuid). Callers receive the raw uuid here (unchanged from today).
    project: s.projectId,
    status: s.status,
    // add-session-model-authority: single-letter family tag from the row's raw
    // stored model; `null` when the row has no model yet.
    model: modelFamilyLetter({ id: s.model ?? undefined }) ?? null,
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

  // All known accounts' 5H/7D usage — additive to the legacy overview shape.
  let accounts: Account5H7D[] = [];
  try {
    const rows = await db.select().from(credentials);
    accounts = rows.map(toAccount5H7D);
  } catch (err) {
    log.warn({ err }, "statusline: failed to query accounts");
  }

  return {
    sessions: statuslineSessions,
    git,
    machine,
    uptime_seconds: uptimeSeconds,
    daemon_count: statuslineSessions.length,
    accounts,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleStatusline(db: Db, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  const accountId = url.searchParams.get("accountId");

  // Both present → 400 (mutually exclusive).
  if (sessionId && accountId) {
    return jsonResponse(
      { error: "sessionId and accountId are mutually exclusive" },
      400,
    );
  }

  // accountId mode → one account's usage (404 if unknown).
  if (accountId) {
    const account = await buildAccountStatus(db, accountId);
    if (!account) return jsonResponse({ error: "unknown account" }, 404);
    return jsonResponse({ account });
  }

  // sessionId mode → composed single-session status (404 if unknown).
  if (sessionId) {
    const vm = createVmReadClient();
    const session = await buildSessionStatus(db, vm, sessionId);
    if (!session) return jsonResponse({ error: "unknown session" }, 404);
    return jsonResponse({ session });
  }

  // Neither → today's overview + all-accounts usage.
  return jsonResponse(await buildOverview(db));
}
