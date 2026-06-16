import { trace, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * Initialize OpenTelemetry tracing for the nexus-agent process.
 *
 * Side-effecting (mirrors ./instrument.ts): importing this module registers a
 * global TracerProvider so that @opentelemetry/api's global `trace` resolves to
 * it — including the trace/span-id mixin in packages/core/src/logger.ts.
 *
 * Must be imported before any other application code that opens spans.
 *
 * Export strategy: full OTel SDK with @opentelemetry/sdk-trace-node (NOT
 * sdk-node) so `bun build --compile` stays happy under Bun.
 *
 * Exporter selection:
 *   - OTEL_EXPORTER_OTLP_ENDPOINT set -> OTLP/HTTP via BatchSpanProcessor
 *   - otherwise                       -> ConsoleSpanExporter (dev fallback)
 */

// service.name matches the logger's resourceAttributes default (logger.ts:18).
const serviceName = process.env.OTEL_SERVICE_NAME ?? "nexus";
const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

/**
 * Build the span processor for the active exporter.
 *
 * In OTel SDK 2.x the processor is passed to the provider constructor via
 * `spanProcessors` (the legacy `provider.addSpanProcessor()` was removed).
 */
function buildSpanProcessor(): SpanProcessor {
  if (otelEndpoint) {
    // BatchSpanProcessor batches and flushes to the OTLP/HTTP receiver.
    return new BatchSpanProcessor(new OTLPTraceExporter());
  }
  // Dev fallback: synchronous console export so spans are visible locally.
  return new SimpleSpanProcessor(new ConsoleSpanExporter());
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
