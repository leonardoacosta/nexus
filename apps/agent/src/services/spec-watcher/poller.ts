/**
 * Subprocess orchestration for the spec-watcher service.
 *
 * Handles `openspec list --json` polling and project registry loading.
 *
 * AUDIT (2026-05-20, homelab-emits-specs-credentials task 1.1):
 *   Why `GET /specs` returned `[]` on the deployed homelab agent:
 *     1. Project enumeration via `getProjects()` (config-loader) returns the
 *        expected ~/.claude/scripts/config/projects.json entries with paths
 *        under ~/dev/* — verified on disk.
 *     2. `pollProjectSpecs(cwd)` shells out to `openspec list --json`
 *        through `execText`. On homelab, `openspec` is NOT installed
 *        (`command not found`). Every invocation fails, the catch swallows
 *        the error at debug level, and `[]` is returned.
 *     3. Result: every project scan returns `[]`, the route emits `[]`,
 *        the Mac dashboard shows "no specs found".
 *
 *   Fix landed in task 1.3: replace the subprocess call with a direct
 *   filesystem scan of `<root>/<project>/openspec/changes/*/` driven by
 *   `services/spec-watcher/config.ts` (task 1.2). The pure-fs path has no
 *   external dependency on the `openspec` CLI binary.
 */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Db } from "@nexus/db";
import { createLogger } from "@nexus/core/node";
import { execText } from "../../utils/exec";
import * as configLoader from "../config-loader";
import { listRegisteredProjects } from "../../db/project-registry";
import { parseSpecList, type SpecSnapshot } from "./parser";
import { SUBPROCESS_TIMEOUT_MS } from "./constants";

const log = createLogger("agent:spec-watcher");

// Injectable getProjects accessor. We deliberately avoid mock.module(
// "./config-loader") in spec-watcher tests because Bun's module mocks are
// process-global and irreversible — they leak into config-loader.test.ts and
// cause spurious failures. Tests override via __setGetProjectsForTesting.
let getProjects: () => ReturnType<typeof configLoader.getProjects> = () =>
  configLoader.getProjects();

/** Test-only: replace the getProjects accessor. */
export function __setGetProjectsForTesting(
  fn: () => ReturnType<typeof configLoader.getProjects>,
): void {
  getProjects = fn;
}

/** Test-only: restore the real getProjects accessor. */
export function __resetGetProjectsForTesting(): void {
  getProjects = () => configLoader.getProjects();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectPath {
  code: string;
  name: string;
  cwd: string;
}

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

/** Load project registry from config-loader cache (static projects.json). */
export function loadProjectRegistry(): ProjectPath[] {
  try {
    return getProjects()
      .map((p) => ({
        code: p.code,
        name: p.name,
        cwd: p.path,
      }))
      .filter((p) => existsSync(join(p.cwd, "openspec")));
  } catch (err) {
    log.debug({ error: err }, "spec-watcher: failed to load project registry");
    return [];
  }
}

/**
 * Registry-first project enumeration: read the auto-discovered
 * `db/project-registry` (non-hidden, active locations) so `/specs` reflects
 * every discovered repo with an `openspec/` directory — not just the static
 * `~/.claude/scripts/config/projects.json`.
 *
 * Falls back to the static `loadProjectRegistry()` when the registry is empty
 * (fresh agent, scan not yet run) so existing behaviour never regresses.
 */
export async function loadProjectRegistryFromDb(db: Db): Promise<ProjectPath[]> {
  try {
    const registered = await listRegisteredProjects(db);
    const projects = registered
      .map((r) => ({
        // The registry has no short `code`; derive a stable one from the
        // directory name (used only as the spec-watcher state-map key).
        code: basename(r.path),
        name: r.name,
        cwd: r.path,
      }))
      .filter((p) => existsSync(join(p.cwd, "openspec")));

    if (projects.length > 0) return projects;

    log.debug("spec-watcher: registry empty — falling back to static projects.json");
    return loadProjectRegistry();
  } catch (err) {
    log.debug(
      { error: err },
      "spec-watcher: registry load failed — falling back to static projects.json",
    );
    return loadProjectRegistry();
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * Run `openspec list --json` in a project directory and parse the output
 * into SpecSnapshot[]. Returns an empty array on any failure.
 *
 * Decorates each snapshot with `has_proposal`/`has_design`/`has_tasks`
 * booleans computed at scan time (agent-payload-completeness) — the parser
 * is a pure function and cannot touch the filesystem, so the decoration
 * happens here.
 */
export async function pollProjectSpecs(cwd: string): Promise<SpecSnapshot[]> {
  const openspecDir = join(cwd, "openspec");
  if (!existsSync(openspecDir)) return [];

  let snapshots: SpecSnapshot[];
  try {
    const stdout = await execText("openspec", ["list", "--json"], {
      cwd,
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    snapshots = parseSpecList(stdout);
  } catch (err) {
    log.debug({ cwd, error: err }, "openspec list --json failed");
    return [];
  }

  for (const snap of snapshots) {
    const specDir = join(openspecDir, "changes", snap.name);
    snap.has_proposal = existsSync(join(specDir, "proposal.md"));
    snap.has_design = existsSync(join(specDir, "design.md"));
    snap.has_tasks = existsSync(join(specDir, "tasks.md"));
  }

  return snapshots;
}
