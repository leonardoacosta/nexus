/**
 * Subprocess orchestration for the spec-watcher service.
 *
 * Handles `openspec list --json` polling and project registry loading.
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
 */
export async function pollProjectSpecs(cwd: string): Promise<SpecSnapshot[]> {
  const openspecDir = join(cwd, "openspec");
  if (!existsSync(openspecDir)) return [];

  try {
    const stdout = await execText("openspec", ["list", "--json"], {
      cwd,
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    return parseSpecList(stdout);
  } catch (err) {
    log.debug({ cwd, error: err }, "openspec list --json failed");
    return [];
  }
}
