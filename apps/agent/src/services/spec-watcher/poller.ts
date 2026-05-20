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
 *   filesystem scan of `<root>/<project>/openspec/changes/<spec>/` driven
 *   by `services/spec-watcher/config.ts` (task 1.2). The pure-fs path has
 *   no external dependency on the `openspec` CLI binary.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Db } from "@nexus/db";
import { createLogger } from "@nexus/core/node";
import * as configLoader from "../config-loader";
import { listRegisteredProjects } from "../../db/project-registry";
import { parseSpecFromPath, type SpecSnapshot } from "./parser";
import { resolveRoots } from "./config";

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
 * Scan a project directory for active OpenSpec change proposals.
 *
 * Enumerates `<cwd>/openspec/changes/<spec>/` directly via readdirSync
 * (no subprocess), filters out the `archive/` sibling and any non-directory
 * entries, and projects each remaining child into a `SpecSnapshot` via
 * `parseSpecFromPath`. The parser computes the has_proposal/has_design/
 * has_tasks tri-state plus completedTasks/totalTasks from tasks.md.
 *
 * Returns `[]` on any error (missing openspec dir, readdir failure, etc.).
 *
 * Historical context: this used to shell out to `openspec list --json` via
 * `execText`. The CLI isn't installed on every agent host (homelab does
 * NOT have it), so every invocation collapsed to []. The pure-fs scan
 * removes that external dependency. See file-header AUDIT block.
 */
export async function pollProjectSpecs(cwd: string): Promise<SpecSnapshot[]> {
  const openspecDir = join(cwd, "openspec");
  if (!existsSync(openspecDir)) return [];

  const changesDir = join(openspecDir, "changes");
  if (!existsSync(changesDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(changesDir);
  } catch (err) {
    log.debug({ cwd, error: err }, "readdir(openspec/changes) failed");
    return [];
  }

  const snapshots: SpecSnapshot[] = [];
  for (const name of entries) {
    // Skip the archive sibling and any hidden entries.
    if (name === "archive" || name.startsWith(".")) continue;

    const specDir = join(changesDir, name);
    try {
      const st = statSync(specDir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }

    const snap = parseSpecFromPath(specDir, name);
    if (snap) snapshots.push(snap);
  }

  return snapshots;
}

/**
 * Scan every resolved workspace root for projects with an
 * `openspec/changes/` directory.
 *
 * For each `<root>/<project>/openspec/changes/<spec>/`, emits one
 * SpecSnapshot decorated with `project` (the project directory name).
 * This is the canonical surface for the `/specs` route — the configured
 * roots replace the per-project subprocess fan-out that depended on the
 * external `openspec` CLI.
 */
export async function scanResolvedRoots(): Promise<
  Array<SpecSnapshot & { project: string; projectCwd: string }>
> {
  const roots = resolveRoots();
  if (roots.length === 0) {
    log.debug("scanResolvedRoots: no roots resolved");
    return [];
  }

  const out: Array<SpecSnapshot & { project: string; projectCwd: string }> = [];

  for (const root of roots) {
    let children: string[];
    try {
      children = readdirSync(root);
    } catch (err) {
      log.debug({ root, error: err }, "scanResolvedRoots: readdir(root) failed");
      continue;
    }

    for (const child of children) {
      if (child.startsWith(".")) continue;
      const projectCwd = join(root, child);
      try {
        const st = statSync(projectCwd);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(join(projectCwd, "openspec", "changes"))) continue;

      const specs = await pollProjectSpecs(projectCwd);
      for (const s of specs) {
        out.push({ ...s, project: child, projectCwd });
      }
    }
  }

  return out;
}
