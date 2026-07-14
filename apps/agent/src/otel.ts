import { metrics, trace, type Meter, type Tracer } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * Initialize OpenTelemetry tracing + metrics for the nexus-agent process.
 *
 * Side-effecting (mirrors ./instrument.ts): importing this module registers a
 * global TracerProvider and MeterProvider so that @opentelemetry/api's global
 * `trace`/`metrics` resolve to them — including the trace/span-id mixin in
 * packages/core/src/logger.ts.
 *
 * Must be imported before any other application code that opens spans or
 * records metrics.
 *
 * Export strategy: full OTel SDK with @opentelemetry/sdk-trace-node +
 * @opentelemetry/sdk-metrics (NOT sdk-node) so `bun build --compile` stays
 * happy under Bun.
 *
 * Exporter selection:
 *   - OTEL_EXPORTER_OTLP_ENDPOINT set -> OTLP/HTTP (BatchSpanProcessor for
 *     traces, PeriodicExportingMetricReader for metrics)
 *   - otherwise                       -> ConsoleSpanExporter (dev fallback);
 *     metrics simply aren't exported (no console-metrics equivalent — it's
 *     noisy and there's nothing to read locally without an endpoint)
 */

// service.name deliberately does NOT match the logger's child-logger label
// ("nexus", logger.ts:83 — a pino child name, not an OTel resource attribute).
// The generic "nexus" risks colliding with a future CC-native-OTel-ingest
// pipeline that might land on the same homelab box under the same service
// identity; "nexus-agent" is unambiguous.
const serviceName = process.env.OTEL_SERVICE_NAME ?? "nexus-agent";
const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

/**
 * Parse `OTEL_EXPORTER_OTLP_HEADERS` into a headers object ourselves rather
 * than letting the exporters read the env var directly. Some OTel SDK
 * versions' env-var parser splits on EVERY `=` in the value, not just the
 * first `key=value` separator — that corrupts base64 Basic-auth padding
 * (base64 padding is literally `=` characters). See
 * `~/.claude/skills/deploy-and-env/SKILL.md` § Observability Canon, Recipe 1.
 */
function parseOtlpHeaders(): Record<string, string> | undefined {
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (!raw) {
    return undefined;
  }
  const idx = raw.indexOf("=");
  if (idx === -1) {
    return undefined;
  }
  const key = raw.slice(0, idx);
  const value = raw.slice(idx + 1);
  return { [key]: value };
}

/**
 * Build the span processor for the active exporter.
 *
 * In OTel SDK 2.x the processor is passed to the provider constructor via
 * `spanProcessors` (the legacy `provider.addSpanProcessor()` was removed).
 */
function buildSpanProcessor(): SpanProcessor {
  if (otelEndpoint) {
    // BatchSpanProcessor batches and flushes to the OTLP/HTTP receiver.
    return new BatchSpanProcessor(
      new OTLPTraceExporter({ headers: parseOtlpHeaders() }),
    );
  }
  // Dev fallback: synchronous console export so spans are visible locally.
  return new SimpleSpanProcessor(new ConsoleSpanExporter());
}

/**
 * Build the metric readers for the active exporter. Unlike traces, there is
 * no console-metrics dev fallback — when no endpoint is configured, metrics
 * simply aren't collected (no readers registered).
 */
function buildMetricReaders(): MetricReader[] {
  if (otelEndpoint) {
    return [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ headers: parseOtlpHeaders() }),
      }),
    ];
  }
  return [];
}

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
  }),
  spanProcessors: [buildSpanProcessor()],
});

// register() wires this provider into @opentelemetry/api's global trace, which
// is what packages/core/src/logger.ts:29-44 reads for its trace/span-id mixin.
provider.register();

const meterProvider = new MeterProvider({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
  }),
  readers: buildMetricReaders(),
});

metrics.setGlobalMeterProvider(meterProvider);

/**
 * Returns the shared tracer for the nexus-agent process.
 *
 * Consumers (e.g. the socket-server dispatcher) import this accessor rather
 * than reaching into the provider directly, so the registration above stays the
 * single source of truth.
 */
export function getTracer(): Tracer {
  return trace.getTracer("nexus-agent");
}

/**
 * Returns the shared meter for the nexus-agent process, mirroring
 * `getTracer()` above.
 */
export function getMeter(): Meter {
  return metrics.getMeter("nexus-agent");
}
