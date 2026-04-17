import { parse as parseTOML } from "smol-toml";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { expandTilde } from "./path";
import { createLogger } from "./logger";

/** Schema for a single agent entry in agents.toml */
export const AgentConfigSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int().positive(),
  user: z.string().optional(),
  projects_dir: z.string().optional(),
});

/** Schema for the full nexus config file */
export const NexusConfigSchema = z.object({
  self_name: z.string().optional(),
  role: z.string().optional(),
  bind_address: z.string().optional(),
  agents: z.array(AgentConfigSchema),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type NexusConfig = z.infer<typeof NexusConfigSchema>;

/** Structured error returned when config parsing fails */
export interface ConfigError {
  type: "read_error" | "toml_error" | "validation_error";
  message: string;
  details?: z.ZodIssue[];
}

export type ConfigResult =
  | { ok: true; config: NexusConfig }
  | { ok: false; error: ConfigError };

/**
 * Parse a nexus agents.toml config file.
 *
 * Returns a discriminated union so callers can handle errors structurally
 * without try/catch.
 */
export function parseConfig(filePath: string): ConfigResult {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    return {
      ok: false,
      error: {
        type: "read_error",
        message: `Failed to read config file: ${(err as Error).message}`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = parseTOML(raw);
  } catch (err) {
    return {
      ok: false,
      error: {
        type: "toml_error",
        message: `Invalid TOML: ${(err as Error).message}`,
      },
    };
  }

  const result = NexusConfigSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: {
        type: "validation_error",
        message: "Config validation failed",
        details: result.error.issues,
      },
    };
  }

  // Expand tilde in projects_dir for every agent entry before returning.
  const config = result.data;
  for (const agent of config.agents) {
    if (agent.projects_dir) {
      agent.projects_dir = expandTilde(agent.projects_dir);
    }
  }

  return { ok: true, config };
}

// ── Agent identity resolver ────────────────────────────────────────────────

const agentIdLog = createLogger("core:config:agent-id");

/**
 * Resolve the standard path to `agents.toml`.
 *
 * Respects `NEXUS_CONFIG_DIR` when set (used by tests and non-standard
 * installs), otherwise defaults to `~/.config/nexus/agents.toml`.
 */
export function getAgentsConfigPath(): string {
  const dir = process.env.NEXUS_CONFIG_DIR;
  if (dir) return join(dir, "agents.toml");
  return join(homedir(), ".config", "nexus", "agents.toml");
}

/** Internal memo so the fallback warning only fires once per process. */
let cachedAgentId: string | null = null;
let fallbackWarned = false;

/**
 * Reset the cached agent identity. Test-only — production code should
 * treat `getAgentId()` as memoised for the process lifetime.
 */
export function resetAgentIdCache(): void {
  cachedAgentId = null;
  fallbackWarned = false;
}

/**
 * Resolve the canonical agent identity for this process.
 *
 * Preference order:
 *   1. The `name` of the agent entry in `agents.toml` whose `name` matches
 *      the top-level `self_name` key.
 *   2. `os.hostname()` as a fallback — logged once on first use.
 *
 * The result is memoised for the process lifetime. This is the single
 * source of truth for "which row in the `agents` table is me?" — callers
 * MUST use this helper instead of `os.hostname()` directly so that
 * container, pod, or custom-hostname deploys can override identity via
 * `agents.toml` without touching the machine hostname.
 *
 * @param configPath Optional explicit path to `agents.toml` (tests).
 *                    Defaults to {@link getAgentsConfigPath}.
 */
export function getAgentId(configPath?: string): string {
  if (cachedAgentId !== null) return cachedAgentId;

  const path = configPath ?? getAgentsConfigPath();
  const result = parseConfig(path);

  if (result.ok) {
    const { self_name, agents } = result.config;
    if (self_name) {
      const match = agents.find((a) => a.name === self_name);
      if (match) {
        cachedAgentId = match.name;
        agentIdLog.info(
          { agentId: cachedAgentId, source: "config", configPath: path },
          "agent identity resolved from agents.toml",
        );
        return cachedAgentId;
      }
      // self_name is set but no matching agent entry — still fall back,
      // but surface the misconfiguration loudly.
      if (!fallbackWarned) {
        fallbackWarned = true;
        agentIdLog.warn(
          { self_name, configPath: path, agentNames: agents.map((a) => a.name) },
          "agents.toml self_name does not match any [[agents]] entry — falling back to os.hostname()",
        );
      }
    }
  } else if (result.error.type !== "read_error") {
    // Only warn for non-read errors. A missing file is the common
    // single-machine deploy case and shouldn't be noisy.
    if (!fallbackWarned) {
      fallbackWarned = true;
      agentIdLog.warn(
        { configPath: path, error: result.error },
        "failed to parse agents.toml — falling back to os.hostname()",
      );
    }
  }

  const fallback = hostname();
  if (!fallbackWarned) {
    fallbackWarned = true;
    agentIdLog.warn(
      { agentId: fallback, configPath: path },
      "no agent identity configured in agents.toml — falling back to os.hostname()",
    );
  }
  cachedAgentId = fallback;
  return cachedAgentId;
}
