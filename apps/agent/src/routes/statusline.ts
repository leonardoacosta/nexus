/**
 * GET /statusline — session overview, git status, machine metrics.
 *
 * Split from operational.ts.
 */

import type { Db } from "@nexus/db";
import { createLogger } from "@nexus/core/node";
import { modelFamilyLetter } from "@nexus/core";
import os from "node:os";
import { queryActiveSessions } from "../db/sessions";
import type { SessionRow } from "../db/sessions";
import { execText } from "../utils/exec";

const log = createLogger("agent:routes:statusline");

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Types
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
// Handler
// ---------------------------------------------------------------------------

export async function handleStatusline(db: Db): Promise<Response> {
  let sessions: SessionRow[] = [];
  try {
    sessions = await queryActiveSessions(db);
  } catch (err) {
    log.warn({ err }, "statusline: failed to query sessions");
  }

  const statuslineSessions: StatuslineSession[] = sessions.map((s) => ({
    id: s.id,
    // NOTE: `sessions.project` (text name) was dropped in favor of `projectId` (uuid).
    // Until a join is added (capability 3), callers receive the raw uuid here.
    project: s.projectId,
    status: s.status,
    // add-session-model-authority: derive the single-letter family tag from the
    // row's raw stored model (populated by the hook-ingest spine) instead of a
    // hardcoded null. `null` still results when the row has no model yet.
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
