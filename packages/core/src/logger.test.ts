import { describe, test, expect, afterEach } from "bun:test";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import type { Context, ContextManager } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-node";

/**
 * Captures process.stdout.write() calls made synchronously inside `fn`.
 *
 * Pino's default (transport-less) destination writes directly via
 * process.stdout.write() on every log call. A pino *transport* instead
 * hands the line off to a worker thread over thread-stream and returns
 * before the write is observable here — so if a transport were attached,
 * `fn()` would return with `lines` still empty. Seeing the JSON line show
 * up immediately, synchronously, is the proof there is no transport,
 * without reaching into pino's internal stream/transport symbols.
 */
function captureSyncStdout(fn: () => void): string[] {
  const original = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return lines;
}

/**
 * logger.ts reads OTEL_EXPORTER_OTLP_ENDPOINT once at module-load time to
 * decide whether to build the OTel mixin, so exercising both branches
 * requires a fresh module instance per branch. A cache-busting query
 * string on the specifier forces Bun to re-evaluate the module instead of
 * returning the already-imported singleton.
 */
async function freshCreateLogger(
  otelEndpoint: string | undefined,
): Promise<typeof import("./logger").createLogger> {
  if (otelEndpoint === undefined) {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  } else {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = otelEndpoint;
  }
  const mod = await import(`./logger.ts?bust=${Math.random()}`);
  return mod.createLogger as typeof import("./logger").createLogger;
}

/**
 * Minimal synchronous stack-based ContextManager. @opentelemetry/api ships
 * only a NoopContextManager (context.active() always returns ROOT_CONTEXT,
 * proven empirically — see logger.ts task notes); a real context manager
 * (e.g. AsyncHooksContextManager from @opentelemetry/context-async-hooks)
 * is not a declared dependency of this package. This local stand-in is
 * sufficient because every test call enters and reads context synchronously
 * with no async gap in between — no async-local-storage tracking needed.
 * Registered and disabled within a single test's try/finally so it never
 * leaks into other tests sharing this process.
 */
class TestStackContextManager implements ContextManager {
  private stack: Context[] = [ROOT_CONTEXT];

  active(): Context {
    return this.stack[this.stack.length - 1]!;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    this.stack.push(ctx);
    try {
      return fn.call(thisArg, ...args);
    } finally {
      this.stack.pop();
    }
  }

  bind<T>(_ctx: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.stack = [ROOT_CONTEXT];
    return this;
  }
}

describe("logger", () => {
  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  test("no transport when OTEL_EXPORTER_OTLP_ENDPOINT is unset — synchronous plain JSON", async () => {
    const createLogger = await freshCreateLogger(undefined);
    const log = createLogger("test-unset");

    const lines = captureSyncStdout(() => {
      log.info({ foo: "bar" }, "hello");
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.msg).toBe("hello");
    expect(parsed.foo).toBe("bar");
  });

  test("no transport when OTEL_EXPORTER_OTLP_ENDPOINT is set — still synchronous plain JSON", async () => {
    const createLogger = await freshCreateLogger("http://localhost:4318");
    const log = createLogger("test-set");

    const lines = captureSyncStdout(() => {
      log.info({ foo: "bar" }, "hello");
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.msg).toBe("hello");
    expect(parsed.foo).toBe("bar");
  });

  test("mixin injects traceId/spanId when a span is active", async () => {
    const createLogger = await freshCreateLogger("http://localhost:4318");
    const log = createLogger("test-span");

    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer("logger-test");

    const contextManager = new TestStackContextManager();
    context.setGlobalContextManager(contextManager);

    let parsed: Record<string, unknown> = {};
    let expectedTraceId = "";
    let expectedSpanId = "";
    try {
      tracer.startActiveSpan("test-span", (span) => {
        const spanContext = span.spanContext();
        expectedTraceId = spanContext.traceId;
        expectedSpanId = spanContext.spanId;

        const lines = captureSyncStdout(() => {
          log.info("inside span");
        });
        parsed = JSON.parse(lines[0]!) as Record<string, unknown>;

        span.end();
      });
    } finally {
      context.disable();
      await provider.shutdown();
    }

    expect(expectedTraceId).not.toBe("");
    expect(parsed.traceId).toBe(expectedTraceId);
    expect(parsed.spanId).toBe(expectedSpanId);
  });

  test("no traceId/spanId when no span is active", async () => {
    const createLogger = await freshCreateLogger("http://localhost:4318");
    const log = createLogger("test-no-span");

    const lines = captureSyncStdout(() => {
      log.info("outside span");
    });
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;

    expect(parsed.msg).toBe("outside span");
    expect(parsed.traceId).toBeUndefined();
    expect(parsed.spanId).toBeUndefined();
    expect("traceId" in parsed).toBe(false);
    expect("spanId" in parsed).toBe(false);
  });
});
