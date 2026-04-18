/**
 * Subprocess orchestration for the spec-watcher service.
 *
 * Handles `openspec list --json` polling and project registry loading.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@nexus/core/node";
import { execText } from "../../utils/exec";
import { getProjects } from "../config-loader";
import { parseSpecList, type SpecSnapshot } from "./parser";
import { SUBPROCESS_TIMEOUT_MS } from "./constants";

const log = createLogger("agent:spec-watcher");

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

/** Load project registry from config-loader cache. */
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
