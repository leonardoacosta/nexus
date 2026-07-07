/**
 * GET /beads/unlinked?project=<code>
 *
 * Open + in_progress beads NOT referenced by any live (non-archived)
 * proposal's `tasks.md` — unplanned work surfaced alongside proposal-linked
 * work (add-bead-proposal-roadmap-surface).
 *
 * Read-only. Degrades to `{ unlinked: [] }` on any bd failure or when the
 * project has no `.beads/` directory (never 500).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@nexus/core/node";
import type { UnlinkedBead } from "@nexus/core";
import { getProjects, type ProjectConfig } from "../services/config-loader";
import {
  collectLinkedBeadIds,
  filterUnlinked,
  type RawBead,
} from "../services/bead-rollup";
import { execJson } from "../utils/exec";

const log = createLogger("agent:routes:beads-unlinked");

function resolveProject(code: string): ProjectConfig | null {
  return getProjects().find((p) => p.code === code) ?? null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleGetUnlinkedBeads(url: URL): Promise<Response> {
  const code = url.searchParams.get("project");
  if (!code) {
    return json({ error: "missing project query param" }, 400);
  }

  const proj = resolveProject(code);
  if (!proj) {
    return json({ error: `unknown project: ${code}` }, 404);
  }

  if (!existsSync(join(proj.path, ".beads"))) {
    return json({ unlinked: [] });
  }

  let open: RawBead[];
  try {
    open = await execJson<RawBead[]>(
      "bd",
      ["list", "--status", "open,in_progress", "--json"],
      { cwd: proj.path },
    );
  } catch (err) {
    log.warn({ project: code, err }, "bd list failed; returning empty unlinked");
    return json({ unlinked: [] });
  }

  const linked = collectLinkedBeadIds(proj.path);
  const unlinked: UnlinkedBead[] = filterUnlinked(
    Array.isArray(open) ? open : [],
    linked,
  );

  return json({ unlinked });
}
