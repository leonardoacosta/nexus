/**
 * GET /roadmap?project=<code>  |  GET /roadmap?project=all
 *
 * Capability roadmap — `[CAPABILITY]` epics, their child proposals (mapped
 * via each feature bead's `spec_id`), per-proposal bead rollups, and
 * per-capability task progress (add-bead-proposal-roadmap-surface).
 *
 * `?project=<code>` returns one project's capabilities (byte-compatible with
 * the pre-change shape). `?project=all` fans `computeRoadmap` out across every
 * non-hidden fleet project, tagging each capability with its source `project`
 * code and degrading per-project (refocus-board-shell).
 *
 * Read-only. Delegates to `computeRoadmap`, which degrades to `[]` on any
 * bd failure or when the project has no `.beads/` directory (never 500).
 */

import type { Db } from "@nexus/db";
import { createLogger } from "@nexus/core/node";
import type { RoadmapCapability } from "@nexus/core";
import { getProjects, type ProjectConfig } from "../services/config-loader";
import { computeRoadmap } from "../services/roadmap-aggregate";
import {
  fanOutAllProjects,
  resolveAllProjects,
  type FanOutProject,
} from "../services/project-fanout";
import { createSingleFlight } from "../utils/single-flight";

const log = createLogger("agent:routes:roadmap");

// Coalesce concurrent `project=all` recomputes (nx-veo5g.2 #2). Module-level so
// it spans requests; keyed per-route since the `all` computation is request-
// independent in production (deps default to the live sources).
const roadmapAllSingleFlight = createSingleFlight<RoadmapCapability[]>();

/** Test seams — default to the live sources. */
export interface RoadmapRouteDeps {
  resolveProjects?: (db?: Db) => Promise<FanOutProject[]>;
  computeRoadmap?: (path: string) => Promise<RoadmapCapability[]>;
}

function resolveProject(code: string): ProjectConfig | null {
  return getProjects().find((p) => p.code === code) ?? null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleGetRoadmap(
  url: URL,
  db?: Db,
  deps: RoadmapRouteDeps = {},
): Promise<Response> {
  const compute = deps.computeRoadmap ?? computeRoadmap;
  const code = url.searchParams.get("project");
  if (!code) {
    return json({ error: "missing project query param" }, 400);
  }

  if (code === "all") {
    const resolveProjects = deps.resolveProjects ?? resolveAllProjects;
    const capabilities = await roadmapAllSingleFlight("roadmap:all", async () => {
      const projects = await resolveProjects(db);
      return fanOutAllProjects<RoadmapCapability>(
        projects,
        (path) => compute(path),
        (cap, project) => ({ ...cap, project }),
        log,
      );
    });
    return json({ capabilities });
  }

  const proj = resolveProject(code);
  if (!proj) {
    return json({ error: `unknown project: ${code}` }, 404);
  }

  let capabilities: RoadmapCapability[];
  try {
    capabilities = await compute(proj.path);
  } catch (err) {
    log.warn({ project: code, err }, "computeRoadmap threw; returning empty");
    capabilities = [];
  }

  return json({ capabilities });
}
