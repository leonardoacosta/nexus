import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

/**
 * Root Pino logger instance.
 * All module loggers are children of this root — LOG_LEVEL changes propagate automatically.
 */
const root = pino({
  level,
  base: undefined, // omit pid/hostname from every line
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Create a named child logger for a specific module or component.
 * Each child inherits the root level and transport config.
 *
 * @example
 *   const log = createLogger("agent:health");
 *   log.info({ cpu: 42 }, "health snapshot written");
 */
export function createLogger(name: string): pino.Logger {
  return root.child({ name });
}

/**
 * Singleton logger for code that doesn't warrant a named module.
 * Prefer createLogger() for new code.
 */
export const logger = createLogger("nexus");

export type Logger = pino.Logger;
export type { Level as LogLevel } from "pino";
