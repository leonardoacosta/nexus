import pino from "pino";

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
