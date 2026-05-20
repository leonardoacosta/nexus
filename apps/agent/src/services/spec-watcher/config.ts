/**
 * spec-watcher configuration loader.
 *
 * Reads `~/.config/nexus/spec-watcher.toml` for the operator-configured
 * `roots` array; falls back to `[~/dev]` when the file is missing or
 * malformed. Exposes `resolveRoots()` which expands tildes, filters to
 * directories that exist on disk, and returns absolute paths.
 *
 * Wire shape:
 *   [spec-watcher]
 *   roots = ["~/dev", "~/work/clientX"]
 *   poll_interval_ms = 60000   # optional, defaults to constants.POLL_INTERVAL_MS
 *
 * The watcher scans `<root>/*\/openspec/changes/*\/` for each resolved root
 * — see poller.ts `scanResolvedRoots` for the glob semantics.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseTOML } from "smol-toml";
import { createLogger, expandTilde } from "@nexus/core/node";
import { POLL_INTERVAL_MS } from "./constants";

const log = createLogger("agent:spec-watcher:config");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Default root list when config is missing or empty. */
const DEFAULT_ROOTS = ["~/dev"];

function configPath(): string {
  const dir = process.env.NEXUS_CONFIG_DIR;
  if (dir) return join(dir, "spec-watcher.toml");
  return join(homedir(), ".config", "nexus", "spec-watcher.toml");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpecWatcherConfig {
  /** Raw, tilde-bearing entries as they appeared in the config (for logging). */
  rawRoots: string[];
  /** Configured poll interval in ms. Falls back to constants.POLL_INTERVAL_MS. */
  pollIntervalMs: number;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Read + parse the config file. Returns defaults on any failure. */
export function loadConfig(filePath?: string): SpecWatcherConfig {
  const path = filePath ?? configPath();

  if (!existsSync(path)) {
    log.debug({ path }, "spec-watcher.toml not present — using defaults");
    return { rawRoots: [...DEFAULT_ROOTS], pollIntervalMs: POLL_INTERVAL_MS };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    log.warn({ path, error: err }, "failed to read spec-watcher.toml — using defaults");
    return { rawRoots: [...DEFAULT_ROOTS], pollIntervalMs: POLL_INTERVAL_MS };
  }

  let parsed: unknown;
  try {
    parsed = parseTOML(raw);
  } catch (err) {
    log.warn({ path, error: err }, "spec-watcher.toml parse error — using defaults");
    return { rawRoots: [...DEFAULT_ROOTS], pollIntervalMs: POLL_INTERVAL_MS };
  }

  // Accept both the top-level shape (`roots = [...]`) and the namespaced
  // shape (`[spec-watcher]\nroots = [...]`).
  const root = parsed as Record<string, unknown>;
  const nested = root["spec-watcher"] as Record<string, unknown> | undefined;

  const rootsCandidate = nested?.roots ?? root.roots;
  const intervalCandidate = nested?.poll_interval_ms ?? root.poll_interval_ms;

  const rawRoots = isStringArray(rootsCandidate) ? rootsCandidate : DEFAULT_ROOTS;
  const pollIntervalMs =
    typeof intervalCandidate === "number" && intervalCandidate > 0
      ? intervalCandidate
      : POLL_INTERVAL_MS;

  return { rawRoots: [...rawRoots], pollIntervalMs };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Expand tildes, filter to existing directories, and return as absolute
 * paths. Duplicates (after expansion) are removed so re-runs see a stable
 * set even when the operator lists overlapping roots.
 */
export function resolveRoots(rawRoots: string[] = loadConfig().rawRoots): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const r of rawRoots) {
    const expanded = expandTilde(r);
    if (seen.has(expanded)) continue;
    seen.add(expanded);

    if (!existsSync(expanded)) {
      log.debug({ root: expanded }, "spec-watcher root does not exist — skipping");
      continue;
    }
    try {
      const stat = statSync(expanded);
      if (!stat.isDirectory()) {
        log.debug({ root: expanded }, "spec-watcher root is not a directory — skipping");
        continue;
      }
    } catch (err) {
      log.debug({ root: expanded, error: err }, "stat() failed on spec-watcher root");
      continue;
    }

    out.push(expanded);
  }

  return out;
}
