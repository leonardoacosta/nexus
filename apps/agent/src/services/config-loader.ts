/**
 * Config Loader — cached reads of projects.json and settings.json.
 *
 * Call `initConfigLoader()` once at startup to populate caches and start
 * fs.watch watchers. Subsequent calls to `getProjects()` / `getSettings()`
 * return the cached values (refreshed automatically on file change).
 *
 * Call `stopConfigLoader()` during shutdown to close watchers.
 */

import { readFileSync, watch, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger, expandTilde } from "@nexus/core";

const log = createLogger("agent:config-loader");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectConfig {
  code: string;
  name: string;
  path: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECTS_PATH = join(homedir(), ".claude/scripts/config/projects.json");
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
    const contents = readFileSync(PROJECTS_PATH, "utf8");
    const parsed = JSON.parse(contents) as {
      projects: Array<{ code: string; name: string; path: string }>;
    };
    return parsed.projects.map((p) => ({
      code: p.code,
      name: p.name,
      path: expandTilde(p.path),
    }));
  } catch {
    log.debug("config-loader: projects.json not found or invalid, returning empty array");
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

  // Watch projects.json.
  if (!projectsWatcher && existsSync(PROJECTS_PATH)) {
    try {
      projectsWatcher = watch(PROJECTS_PATH, () => {
        if (debounceProjectsTimer) clearTimeout(debounceProjectsTimer);
        debounceProjectsTimer = setTimeout(() => {
          projectsCache = loadProjects();
          log.info(
            { projects: projectsCache.length },
            "config-loader: projects.json reloaded",
          );
        }, DEBOUNCE_MS);
      });
    } catch (err) {
      log.warn({ error: err }, "config-loader: failed to watch projects.json");
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
