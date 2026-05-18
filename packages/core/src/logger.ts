import pino from "pino";

import { scriptErrorLogHook } from "./node/pino-db-transport";

const level = process.env.LOG_LEVEL ?? "info";
const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

/**
 * Build transport config — only used when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * pino-opentelemetry-transport forwards logs to an OTLP receiver.
 */
function buildTransport(): pino.TransportSingleOptions | undefined {
  if (!otelEndpoint) return undefined;
  return {
    target: "pino-opentelemetry-transport",
    options: {
      resourceAttributes: {
        "service.name": process.env.OTEL_SERVICE_NAME ?? "nexus",
      },
    },
  };
}

/**
 * Mixin that injects active OTel trace/span IDs into every log record.
 * Falls back gracefully when @opentelemetry/api is not installed or no
 * active span exists (returns empty object — no log fields added).
 */
function buildMixin(): (() => Record<string, string>) | undefined {
  if (!otelEndpoint) return undefined;
  try {
    // Dynamic require so pino-opentelemetry-transport remains optional at import time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trace, context } = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
    return (): Record<string, string> => {
      const span = trace.getSpan(context.active());
      if (!span) return {};
      const { traceId, spanId } = span.spanContext();
      return { traceId, spanId };
    };
  } catch {
    return undefined;
  }
}

const transport = buildTransport();
const mixin = buildMixin();

/**
 * Root Pino logger instance.
 * All module loggers are children of this root — LOG_LEVEL changes propagate automatically.
 * When OTEL_EXPORTER_OTLP_ENDPOINT is set, logs are forwarded to the OTLP receiver and
 * active trace/span IDs are injected into every log record.
 */
const root = pino({
  level,
  base: undefined, // omit pid/hostname from every line
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(mixin ? { mixin } : {}),
  ...(transport ? { transport } : {}),
});

/**
 * Create a named child logger for a specific module or component.
 * Each child inherits the root level and transport config.
 *
 * When `attachScriptErrorSink()` has been called by the script entry point,
 * warn/error/fatal records are also persisted to the `script_errors` table
 * via `pino-db-transport`. Info/debug/trace remain stdout-only.
 *
 * @example
 *   const log = createLogger("agent:health");
 *   log.info({ cpu: 42 }, "health snapshot written");
 */
export function createLogger(name: string): pino.Logger {
  const child = root.child({ name });
  // Patch the child's level methods to invoke the DB hook. We do this here
  // rather than in pino's `hooks.logMethod` factory option so the hook only
  // applies to loggers created through this API — third-party pino instances
  // are untouched.
  // Pino logger methods are properties on the instance; we wrap warn/error/fatal.
  const original = {
    warn: child.warn.bind(child),
    error: child.error.bind(child),
    fatal: child.fatal.bind(child),
  };
  const hook = scriptErrorLogHook(name);
  child.warn = ((...args: unknown[]) =>
    hook.call(child as never, args, original.warn, 40)) as typeof child.warn;
  child.error = ((...args: unknown[]) =>
    hook.call(child as never, args, original.error, 50)) as typeof child.error;
  child.fatal = ((...args: unknown[]) =>
    hook.call(child as never, args, original.fatal, 60)) as typeof child.fatal;
  return child;
}

/**
 * Singleton logger for code that doesn't warrant a named module.
 * Prefer createLogger() for new code.
 */
export const logger = createLogger("nexus");

export type Logger = pino.Logger;
export type { Level as LogLevel } from "pino";
