import { readFileSync, statSync } from "node:fs";
import * as childProcess from "node:child_process";
import { statePath } from "./cache-io";
import { deriveProjectCode } from "./project";

// ── Bead / roadmap surface lines (add-bead-proposal-roadmap-surface) ─────────

const BEAD_LINE_CACHE_TTL_MS = 300_000; // 5 minutes — same TTL as the pulse cache

// Constant curl-refresh script — $1 = url, $2 = cache path, positional only.
// `curl -f` + `&&` means a down/erroring agent leaves the cache untouched.
// `$$`-suffixed tmp path + `|| rm -f` cleanup on failure avoids two concurrent
// refresh spawns interleaving into one shared tmp file.
const CURL_REFRESH_SCRIPT =
  'curl -sf --max-time 3 "$1" > "${2}.$$.tmp" 2>/dev/null && mv "${2}.$$.tmp" "$2" || rm -f "${2}.$$.tmp"';

/** One `/roadmap` capability (only the fields the roadmap line reads). */
interface RoadmapCapabilityRow {
  name: string;
  progress: { totalTasks: number; closedTasks: number };
}

/** `/roadmap?project=<code>` payload (only the fields the roadmap line reads). */
interface RoadmapResponse {
  capabilities?: RoadmapCapabilityRow[];
}

/**
 * Roadmap line: the least-complete capability, rendered `<name> <pct>%` where
 * `pct` is completion (`closedTasks/totalTasks`). Only capabilities with
 * `totalTasks > 0` are eligible. Returns null when none qualify — line omitted.
 */
export function formatRoadmapLine(
  capabilities: RoadmapCapabilityRow[] | undefined,
): string | null {
  if (!capabilities || capabilities.length === 0) return null;

  const withTasks = capabilities.filter((c) => c.progress.totalTasks > 0);
  if (withTasks.length === 0) return null;

  let least = withTasks[0]!;
  let leastRatio = least.progress.closedTasks / least.progress.totalTasks;
  for (const c of withTasks) {
    const r = c.progress.closedTasks / c.progress.totalTasks;
    if (r < leastRatio) {
      least = c;
      leastRatio = r;
    }
  }

  return `${least.name} ${Math.round(leastRatio * 100)}%`;
}

/**
 * Read a cached agent JSON payload, stale-while-revalidate: serve the cached
 * file (mtime = freshness) and, when stale, kick off a detached `curl`
 * refresh that writes the raw agent response to the cache for a future
 * render. `curl -f` + `&&` means a down/erroring agent leaves the cache
 * untouched (stays stale → retried next render) rather than clobbering it
 * with an empty file. First-ever render returns null (empty on first render
 * — no blocking).
 */
function readCachedAgentJson<T>(cachePath: string, url: string): T | null {
  let data: T | null = null;
  let stale = true;
  try {
    stale = Date.now() - statSync(cachePath).mtimeMs > BEAD_LINE_CACHE_TTL_MS;
    data = JSON.parse(readFileSync(cachePath, "utf-8")) as T;
  } catch {
    // No cache yet / unparseable — treat as stale, return null.
    stale = true; // a corrupt-but-fresh cache must still trigger a refresh
  }

  if (stale) {
    const child = childProcess.spawn(
      "sh",
      ["-c", CURL_REFRESH_SCRIPT, "sh", url, cachePath],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  }

  return data;
}

/**
 * Roadmap line for the statusline, sourced from the agent's
 * `GET /roadmap?project=<code>` behind the stale-while-revalidate cache.
 * Empty on first render.
 */
export function getRoadmapLine(projectDir: string, agentUrl: string): string | null {
  try {
    const code = deriveProjectCode(projectDir);
    const cachePath = statePath(`bead-roadmap.${code}.json`);
    const data = readCachedAgentJson<RoadmapResponse>(
      cachePath,
      `${agentUrl}/roadmap?project=${code}`,
    );
    return formatRoadmapLine(data?.capabilities);
  } catch {
    return null;
  }
}

