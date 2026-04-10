/**
 * GET /recommend — next-action recommendation engine.
 *
 * Split from operational.ts.
 */

import type { Db } from "@nexus/db";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { queryActiveSessions } from "../db/sessions";
import type { SessionRow } from "../db/sessions";
import { execJson } from "../utils/exec";

// ---------------------------------------------------------------------------
// Types
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

// ---------------------------------------------------------------------------
// Cache (30 seconds)
// ---------------------------------------------------------------------------

let recommendCache: { value: RecommendResponse | null; refreshedAt: number } = {
  value: null,
  refreshedAt: 0,
};
const RECOMMEND_CACHE_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Recommendation builder
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

interface BdReadyItem {
  id: string;
  title: string;
  priority: number;
  issue_type: string;
  created_at: string;
}

async function fetchBdReady(): Promise<BdReadyItem[]> {
  try {
    const items = await execJson<unknown[]>("bd", ["ready", "--json"]);
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
    const contents = await readFile(path, "utf8");
    return JSON.parse(contents) as MasterContext;
  } catch {
    return null;
  }
}
