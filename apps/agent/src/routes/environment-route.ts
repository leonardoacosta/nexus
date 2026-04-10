/**
 * GET /environment — dependency, config, and service checks.
 *
 * Split from operational.ts.
 */

import os from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execText } from "../utils/exec";
import { getSettings } from "../services/config-loader";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DependencyCheck {
  found: boolean;
  version?: string;
  auth?: boolean;
}

interface EnvironmentResponse {
  status: string;
  checks: {
    dependencies: Record<string, DependencyCheck>;
    config: {
      settings_json: { valid: boolean; path: string };
      master_context: { exists: boolean; path: string };
      bin_dir: { exists: boolean; count: number };
    };
    services: {
      nexus_agent: { running: boolean; uptime_seconds: number };
      nexus_socket: { exists: boolean; path: string };
    };
  };
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Cache (60 seconds)
// ---------------------------------------------------------------------------

let envCache: { value: EnvironmentResponse | null; refreshedAt: number } = {
  value: null,
  refreshedAt: 0,
};
const ENV_CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleEnvironment(): Promise<Response> {
  const now = Date.now();
  const uptimeSeconds = Math.floor((now - startedAt) / 1000);

  if (now - envCache.refreshedAt < ENV_CACHE_TTL_MS && envCache.value) {
    // Update uptime and timestamp in cached copy.
    const cached = { ...envCache.value };
    cached.checks.services.nexus_agent.uptime_seconds = uptimeSeconds;
    cached.timestamp = new Date().toISOString();
    return new Response(JSON.stringify(cached), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const response = await collectEnvironment(uptimeSeconds);
  envCache = { value: response, refreshedAt: now };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Collection logic
// ---------------------------------------------------------------------------

async function collectEnvironment(
  uptimeSeconds: number,
): Promise<EnvironmentResponse> {
  const home = os.homedir();

  // Check dependencies in parallel.
  const [bd, git, jq, node, cargo, gh, openspec] = await Promise.all([
    checkDependency("bd", ["--version"]),
    checkDependency("git", ["--version"]),
    checkDependency("jq", ["--version"]),
    checkDependency("node", ["--version"]),
    checkDependency("cargo", ["--version"]),
    checkGh(),
    checkDependency("openspec", ["--version"]),
  ]);

  const dependencies: Record<string, DependencyCheck> = {
    bd,
    git,
    jq,
    node,
    cargo,
    gh,
    openspec,
  };

  // Config checks.
  const settingsPath = join(home, ".claude/settings.json");
  const masterContextPath = join(home, ".claude/scripts/state/master-context.json");
  const binDirPath = join(home, ".claude/scripts/bin");

  let settingsValid = false;
  try {
    const settings = getSettings();
    settingsValid = existsSync(settingsPath) && typeof settings === "object";
  } catch {
    // Invalid or missing.
  }

  const masterContextExists = existsSync(masterContextPath);

  let binDirExists = false;
  let binDirCount = 0;
  try {
    const entries = readdirSync(binDirPath);
    binDirExists = true;
    binDirCount = entries.length;
  } catch {
    // Missing.
  }

  // Service checks.
  const socketPath = "/tmp/nexus-agent.sock";
  const socketExists = existsSync(socketPath);

  const gitFound = dependencies.git?.found ?? false;
  const anyMissing = Object.values(dependencies).some((d) => !d.found);

  const status = !gitFound ? "critical" : anyMissing ? "degraded" : "healthy";

  return {
    status,
    checks: {
      dependencies,
      config: {
        settings_json: {
          valid: settingsValid,
          path: settingsPath.replace(home, "~"),
        },
        master_context: {
          exists: masterContextExists,
          path: masterContextPath.replace(home, "~"),
        },
        bin_dir: { exists: binDirExists, count: binDirCount },
      },
      services: {
        nexus_agent: { running: true, uptime_seconds: uptimeSeconds },
        nexus_socket: { exists: socketExists, path: socketPath },
      },
    },
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Dependency checkers
// ---------------------------------------------------------------------------

async function checkDependency(
  name: string,
  versionArgs: string[],
): Promise<DependencyCheck> {
  try {
    await execText("which", [name]);
  } catch {
    return { found: false };
  }

  try {
    const versionOut = await execText(name, versionArgs);
    const version = extractVersion(versionOut.trim());
    return { found: true, version };
  } catch {
    return { found: true };
  }
}

async function checkGh(): Promise<DependencyCheck> {
  const dep = await checkDependency("gh", ["--version"]);
  if (!dep.found) return dep;

  try {
    await execText("gh", ["auth", "status"]);
    dep.auth = true;
  } catch {
    dep.auth = false;
  }

  return dep;
}

function extractVersion(raw: string): string {
  const line = raw.split("\n")[0] ?? raw;

  for (const word of line.split(/\s+/)) {
    const trimmed = word.replace(/^v/, "").replace(/^jq-/, "");
    if (/^\d+\./.test(trimmed) && trimmed.includes(".")) {
      return trimmed;
    }
  }

  return line;
}
