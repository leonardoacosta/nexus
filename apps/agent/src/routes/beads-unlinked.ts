/**
 * GET /beads/unlinked?project=<code>  |  GET /beads/unlinked?project=all
 *
 * Open + in_progress beads NOT referenced by any live (non-archived)
 * proposal's `tasks.md` — unplanned work surfaced alongside proposal-linked
 * work (add-bead-proposal-roadmap-surface).
 *
 * `?project=<code>` returns one project's unlinked beads (byte-compatible with
 * the pre-change shape). `?project=all` fans the same computation out across
 * every non-hidden fleet project, tagging each bead with its source `project`
 * code and degrading per-project (refocus-board-shell).
 *
 * Read-only. Degrades to `{ unlinked: [] }` on any bd failure or when the
 * project has no `.beads/` directory (never 500).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@nexus/db";
import { createLogger } from "@nexus/core/node";
import type { UnlinkedBead } from "@nexus/core";
import { getProjects, type ProjectConfig } from "../services/config-loader";
import {
  collectLinkedBeadIds,
  filterUnlinked,
  type RawBead,
} from "../services/bead-rollup";
import {
  fanOutAllProjects,
  resolveAllProjects,
  type FanOutProject,
} from "../services/project-fanout";
import {
  cachedUnlinkedBeadSource,
  type UnlinkedBeadSource,
} from "../services/cached-bead-source";
import { execJson } from "../utils/exec";
import { createSingleFlight } from "../utils/single-flight";

const log = createLogger("agent:routes:beads-unlinked");

// Coalesce concurrent `project=all` recomputes (nx-veo5g.2 #2). Module-level so
// it spans requests; keyed per-route since the `all` computation is request-
// independent in production (deps default to the live sources).
const unlinkedAllSingleFlight = createSingleFlight<UnlinkedBead[]>();

/** Test seams — default to the live sources. */
export interface UnlinkedRouteDeps {
  resolveProjects?: (db?: Db) => Promise<FanOutProject[]>;
  computeUnlinked?: (path: string) => Promise<UnlinkedBead[]>;
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

/**
 * Live-CLI unlinked source — the exact pre-change behaviour
 * (`bd list --status open,in_progress --json`). Default for
 * {@link computeUnlinkedForProject} so tests and any non-route caller keep the
 * original spawn semantics; the route handler swaps in the cached source.
 */
export const defaultUnlinkedBeadSource: UnlinkedBeadSource = {
  listOpenBeads(cwd) {
    return execJson<RawBead[]>(
      "bd",
      ["list", "--status", "open,in_progress", "--json"],
      { cwd },
    );
  },
};

/**
 * Compute one project's unlinked beads. Returns `[]` when the project has no
 * `.beads/` directory; may throw on source failure so a caller can decide to
 * degrade (single-project → `[]`) or exclude (fan-out → warn-log + drop).
 * The single-project handler preserves the pre-change fail-soft behaviour.
 *
 * `source` is the DI seam (nx-veo5g.1): defaults to the live-CLI source so
 * existing callers/tests are byte-identical; the production route passes
 * `cachedUnlinkedBeadSource` to read from the beads-watcher cache instead.
 */
export async function computeUnlinkedForProject(
  projectPath: string,
  source: UnlinkedBeadSource = defaultUnlinkedBeadSource,
): Promise<UnlinkedBead[]> {
  if (!existsSync(join(projectPath, ".beads"))) return [];

  const open = await source.listOpenBeads(projectPath);
  const linked = await collectLinkedBeadIds(projectPath);
  return filterUnlinked(Array.isArray(open) ? open : [], linked);
}

export async function handleGetUnlinkedBeads(
  url: URL,
  db?: Db,
  deps: UnlinkedRouteDeps = {},
): Promise<Response> {
  const compute =
    deps.computeUnlinked ??
    ((path: string) => computeUnlinkedForProject(path, cachedUnlinkedBeadSource));
  const code = url.searchParams.get("project");
  if (!code) {
    return json({ error: "missing project query param" }, 400);
  }

  if (code === "all") {
    const resolveProjects = deps.resolveProjects ?? resolveAllProjects;
    const unlinked = await unlinkedAllSingleFlight("beads-unlinked:all", async () => {
      const projects = await resolveProjects(db);
      return fanOutAllProjects<UnlinkedBead>(
        projects,
        (path) => compute(path),
        (bead, project) => ({ ...bead, project }),
        log,
      );
    });
    return json({ unlinked });
  }

  const proj = resolveProject(code);
  if (!proj) {
    return json({ error: `unknown project: ${code}` }, 404);
  }

  let unlinked: UnlinkedBead[];
  try {
    unlinked = await compute(proj.path);
  } catch (err) {
    log.warn({ project: code, err }, "bd list failed; returning empty unlinked");
    unlinked = [];
  }

  return json({ unlinked });
}
