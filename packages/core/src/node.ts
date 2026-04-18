/**
 * Node-only entry point for @nexus/core.
 *
 * Import as `@nexus/core/node` in server-side code (agent, scripts, CLI).
 * Do NOT import from this module in browser or Next.js client components —
 * these exports depend on node:fs, node:os, node:path, and Bun APIs.
 *
 * Browser-safe types and zod schemas remain on the default barrel (`@nexus/core`).
 */

export { logger, createLogger } from "./logger";
export type { Logger } from "./logger";

export {
  parseConfig,
  AgentConfigSchema,
  NexusConfigSchema,
  getAgentId,
  getAgentsConfigPath,
  resetAgentIdCache,
} from "./config";
export type {
  AgentConfig,
  NexusConfig,
  ConfigError,
  ConfigResult,
} from "./config";

export { expandTilde } from "./path";

export {
  safeSpawn,
  isSafeArg,
  assertAllowedBinary,
  ALLOWED_BINARIES,
  DisallowedBinaryError,
  UnsafeArgError,
} from "./safe-spawn";
export type {
  AllowedBinary,
  SafeSpawnHandle,
  SafeSpawnOptions,
  StdioMode,
} from "./safe-spawn";
