import { parse as parseTOML } from "smol-toml";
import { z } from "zod";
import { readFileSync } from "node:fs";

/** Schema for a single agent entry in agents.toml */
export const AgentConfigSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int().positive(),
  user: z.string().optional(),
});

/** Schema for the full nexus config file */
export const NexusConfigSchema = z.object({
  self_name: z.string(),
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

  return { ok: true, config: result.data };
}
