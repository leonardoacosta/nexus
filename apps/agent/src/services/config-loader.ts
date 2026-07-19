/**
 * Config Loader — cached reads of the project registry (projects.toml) and
 * settings.json.
 *
 * Call `initConfigLoader()` once at startup to populate caches and start
 * fs.watch watchers. Subsequent calls to `getProjects()` / `getSettings()`
 * return the cached values (refreshed automatically on file change).
 *
 * Call `stopConfigLoader()` during shutdown to close watchers.
 *
 * Registry source (repoint-config-loader-to-projects-toml): the project
 * registry used to live at `~/.claude/scripts/config/projects.json` — that
 * file was deleted (cc commit 2e0c2066, migrate-projects-json-to-if-toml) in
 * favor of installfest's `home/projects.toml`, the canonical
 * `[[projects]]` array-of-tables registry cc's own `scripts/lib/
 * projects-toml.sh` already reads. `PROJECTS_TOML_PATH` follows that same
 * hardcoded default, with an env override for tests/alternate machines.
 */

import { readFileSync, watch, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseTOML } from "smol-toml";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:config-loader");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectConfig {
  code: string;
  name: string;
  path: string;
}

/** Shape of one `[[projects]]` entry in projects.toml — only the fields this loader consumes. */
interface TomlProjectEntry {
  code?: unknown;
  name?: unknown;
  path?: unknown;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECTS_TOML_PATH =
  process.env.NEXUS_PROJECTS_TOML ??
  join(homedir(), "dev/personal/installfest/home/projects.toml");
const SETTINGS_PATH = join(homedir(), ".claude/settings.json");

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let projectsCache: ProjectConfig[] = [];
let settingsCache: Record<string, unknown> = {};
let projectsWatcher: ReturnType<typeof watch> | null = null;
let settingsWatcher: ReturnType<typeof watch> | null = null;
let debounceProjectsTimer: ReturnType<typeof setTimeout> | null = null;
let debounceSettingsTimer: ReturnType<typeof setTimeout> | null = null;

const DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

function loadProjects(): ProjectConfig[] {
  try {
    const contents = readFileSync(PROJECTS_TOML_PATH, "utf8");
    const parsed = parseTOML(contents) as { projects?: TomlProjectEntry[] };
    const entries = Array.isArray(parsed.projects) ? parsed.projects : [];
    // path is home-relative in projects.toml (e.g. "dev/oo", ".claude"),
    // unlike the old projects.json's tilde-bearing paths — join to $HOME
    // rather than expandTilde.
    return entries
      .filter(
        (p): p is Required<TomlProjectEntry> & { code: string; name: string; path: string } =>
          typeof p.code === "string" &&
          typeof p.name === "string" &&
          typeof p.path === "string",
      )
      .map((p) => ({
        code: p.code,
        name: p.name,
        path: join(homedir(), p.path),
      }));
  } catch {
    log.debug("config-loader: projects.toml not found or invalid, returning empty array");
    return [];
  }
}

function loadSettings(): Record<string, unknown> {
  try {
    const contents = readFileSync(SETTINGS_PATH, "utf8");
    return JSON.parse(contents) as Record<string, unknown>;
  } catch {
    log.debug("config-loader: settings.json not found or invalid, returning empty object");
    return {};
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Return the cached projects list. */
export function getProjects(): ProjectConfig[] {
  return projectsCache;
}

/** Return the cached settings object. */
export function getSettings(): Record<string, unknown> {
  return settingsCache;
}

/**
 * Initialize the config loader: read files and start fs.watch watchers.
 * Safe to call multiple times (subsequent calls are no-ops).
 */
export function initConfigLoader(): void {
  // Load initial values.
  projectsCache = loadProjects();
  settingsCache = loadSettings();

  log.info(
    { projects: projectsCache.length },
    "config-loader: initial load complete",
  );

  // Watch projects.toml.
  if (!projectsWatcher && existsSync(PROJECTS_TOML_PATH)) {
    try {
      projectsWatcher = watch(PROJECTS_TOML_PATH, () => {
        if (debounceProjectsTimer) clearTimeout(debounceProjectsTimer);
        debounceProjectsTimer = setTimeout(() => {
          projectsCache = loadProjects();
          log.info(
            { projects: projectsCache.length },
            "config-loader: projects.toml reloaded",
          );
        }, DEBOUNCE_MS);
      });
    } catch (err) {
      log.warn({ error: err }, "config-loader: failed to watch projects.toml");
    }
  }

  // Watch settings.json.
  if (!settingsWatcher && existsSync(SETTINGS_PATH)) {
    try {
      settingsWatcher = watch(SETTINGS_PATH, () => {
        if (debounceSettingsTimer) clearTimeout(debounceSettingsTimer);
        debounceSettingsTimer = setTimeout(() => {
          settingsCache = loadSettings();
          log.info("config-loader: settings.json reloaded");
        }, DEBOUNCE_MS);
      });
    } catch (err) {
      log.warn({ error: err }, "config-loader: failed to watch settings.json");
    }
  }
}

/** Stop watchers and clear caches. */
export function stopConfigLoader(): void {
  if (projectsWatcher) {
    projectsWatcher.close();
    projectsWatcher = null;
  }
  if (settingsWatcher) {
    settingsWatcher.close();
    settingsWatcher = null;
  }
  if (debounceProjectsTimer) {
    clearTimeout(debounceProjectsTimer);
    debounceProjectsTimer = null;
  }
  if (debounceSettingsTimer) {
    clearTimeout(debounceSettingsTimer);
    debounceSettingsTimer = null;
  }
  projectsCache = [];
  settingsCache = {};
  log.info("config-loader: stopped");
}
