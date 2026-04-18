/**
 * EnvironmentCache — cache of project environment variables.
 *
 * Reads .env files from project directories and caches the parsed
 * key-value pairs. Refreshed on demand (e.g., when a project is
 * discovered or when the cache expires).
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:services:environment-cache");

/** How long cached env vars remain valid (ms). */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  vars: Record<string, string>;
  refreshedAt: number;
}

export class EnvironmentCache {
  private cache = new Map<string, CacheEntry>();

  /**
   * Get environment variables for a project.
   * Returns cached values if still valid, otherwise refreshes from disk.
   */
  async get(projectCode: string, projectPath: string): Promise<Record<string, string>> {
    const now = Date.now();
    const entry = this.cache.get(projectCode);

    if (entry && now - entry.refreshedAt < CACHE_TTL_MS) {
      return entry.vars;
    }

    return this.refresh(projectCode, projectPath);
  }

  /**
   * Force-refresh environment variables for a project by reading
   * its .env file from disk.
   */
  async refresh(projectCode: string, projectPath: string): Promise<Record<string, string>> {
    const vars = await readEnvFile(projectPath);
    this.cache.set(projectCode, {
      vars,
      refreshedAt: Date.now(),
    });

    log.debug(
      { project: projectCode, varCount: Object.keys(vars).length },
      "environment cache refreshed",
    );

    return vars;
  }

  /** Clear all cached entries. */
  clear(): void {
    this.cache.clear();
  }

  /** Clear a specific project's cache entry. */
  clearProject(projectCode: string): void {
    this.cache.delete(projectCode);
  }
}

// ---------------------------------------------------------------------------
// .env parsing
// ---------------------------------------------------------------------------

/**
 * Read and parse a .env file from the given directory.
 * Returns an empty object if the file doesn't exist or can't be read.
 *
 * Supports:
 *   - KEY=VALUE
 *   - KEY="VALUE" (strips quotes)
 *   - KEY='VALUE' (strips quotes)
 *   - # comments
 *   - Empty lines
 */
async function readEnvFile(projectPath: string): Promise<Record<string, string>> {
  const envPath = join(projectPath, ".env");
  if (!existsSync(envPath)) return {};

  try {
    const contents = await readFile(envPath, "utf8");
    return parseEnv(contents);
  } catch (err) {
    log.debug(
      { path: envPath, error: err instanceof Error ? err.message : String(err) },
      "failed to read .env file",
    );
    return {};
  }
}

function parseEnv(contents: string): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();

    // Skip empty lines and comments.
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Split on first '='.
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      vars[key] = value;
    }
  }

  return vars;
}

// Exported for testing.
export { parseEnv, readEnvFile };
