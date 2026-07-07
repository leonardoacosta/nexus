/**
 * GET /roadmap?project=<code>
 *
 * Capability roadmap — `[CAPABILITY]` epics, their child proposals (mapped
 * via each feature bead's `spec_id`), per-proposal bead rollups, and
 * per-capability task progress (add-bead-proposal-roadmap-surface).
 *
 * Read-only. Delegates to `computeRoadmap`, which degrades to `[]` on any
 * bd failure or when the project has no `.beads/` directory (never 500).
 */

import { createLogger } from "@nexus/core/node";
import type { RoadmapCapability } from "@nexus/core";
import { getProjects, type ProjectConfig } from "../services/config-loader";
import { computeRoadmap } from "../services/roadmap-aggregate";

const log = createLogger("agent:routes:roadmap");

function resolveProject(code: string): ProjectConfig | null {
  return getProjects().find((p) => p.code === code) ?? null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleGetRoadmap(url: URL): Promise<Response> {
  const code = url.searchParams.get("project");
  if (!code) {
    return json({ error: "missing project query param" }, 400);
  }

  const proj = resolveProject(code);
  if (!proj) {
    return json({ error: `unknown project: ${code}` }, 404);
  }

  let capabilities: RoadmapCapability[];
  try {
    capabilities = await computeRoadmap(proj.path);
  } catch (err) {
    log.warn({ project: code, err }, "computeRoadmap threw; returning empty");
    capabilities = [];
  }

  return json({ capabilities });
}
