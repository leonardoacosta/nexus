/**
 * otel.ts getMeter() accessor tests — backfill for task 4.2 of
 * wire-nexus-agent-grafana-otel (getMeter() itself shipped in a prior
 * commit this run, alongside health-collector.ts's own gauge-recording
 * suite in health-collector.test.ts — this file does NOT duplicate that
 * coverage; it targets getMeter()'s own return-value contract).
 *
 * otel.ts registers a global TracerProvider + MeterProvider as an
 * IMPORT-TIME side effect (`provider.register()` /
 * `metrics.setGlobalMeterProvider(...)`). OTel's API guards global
 * registration so only the FIRST successful registration in a process
 * wins — a second call is a silent no-op. Since `bun test` runs every
 * test file in one process, other suites (e.g. health-collector.test.ts)
 * may import otel.ts before this file does, meaning whichever provider
 * won registration is opaque from here. That is exactly why this suite
 * asserts getMeter()'s RETURN VALUE behavior (it hands back a working
 * Meter you can create instruments on and record against without
 * throwing) rather than trying to intercept or re-trigger the module's
 * own global registration.
 */

import { describe, expect, it } from "bun:test";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { getMeter } from "./otel";

describe("getMeter", () => {
  it("returns a Meter that can create and record a gauge without throwing", () => {
    const meter = getMeter();

    expect(meter).toBeDefined();
    expect(typeof meter.createGauge).toBe("function");

    const gauge = meter.createGauge("otel_test_gauge", {
      description: "otel.test.ts smoke gauge",
    });

    expect(() => gauge.record(42, { source: "otel.test.ts" })).not.toThrow();
  });

  it("returns a Meter that can create and record a counter and a histogram without throwing", () => {
    const meter = getMeter();

    const counter = meter.createCounter("otel_test_counter", {
      description: "otel.test.ts smoke counter",
    });
    const histogram = meter.createHistogram("otel_test_histogram", {
      description: "otel.test.ts smoke histogram",
    });

    expect(() => counter.add(1, { source: "otel.test.ts" })).not.toThrow();
    expect(() => histogram.record(10, { source: "otel.test.ts" })).not.toThrow();
  });

  it("returns a usable Meter on repeated calls (no throw, no per-call setup required)", () => {
    const first = getMeter();
    const second = getMeter();

    expect(() =>
      first.createGauge("otel_test_gauge_repeat_a").record(1),
    ).not.toThrow();
    expect(() =>
      second.createGauge("otel_test_gauge_repeat_b").record(2),
    ).not.toThrow();
  });
});

/**
 * Independent sanity check that the OTel metrics pattern otel.ts relies on
 * (MeterProvider + a reader backed by a push exporter, Gauge
 * create-then-record) genuinely round-trips under Bun — using a LOCAL
 * MeterProvider + InMemoryMetricExporter this test owns directly, never
 * touching the global provider otel.ts registers. This does not exercise
 * getMeter() itself (see describe block above for that) — it validates the
 * underlying recording/export mechanics in isolation, which is the safer
 * seam given the module-load global-registration hazard documented above.
 */
describe("OTel gauge recording (local MeterProvider, isolated from global otel.ts registration)", () => {
  it("records a gauge value that is retrievable via forceFlush + getMetrics", async () => {
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    );
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    });
    const localProvider = new MeterProvider({ readers: [reader] });

    try {
      const localMeter = localProvider.getMeter("otel-test-local");
      const gauge = localMeter.createGauge("local_test_gauge");
      gauge.record(99, { case: "local-provider" });

      await reader.forceFlush();
      const exported = exporter.getMetrics();

      const gaugeDataPoints = exported
        .flatMap((rm) => rm.scopeMetrics)
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === "local_test_gauge")?.dataPoints;

      expect(gaugeDataPoints).toBeDefined();
      expect(gaugeDataPoints?.some((dp) => dp.value === 99)).toBe(true);
    } finally {
      await localProvider.shutdown();
    }
  });
});

/**
 * Endpoint-set vs endpoint-unset branch coverage (buildMetricReaders()):
 *
 * otel.ts reads `process.env.OTEL_EXPORTER_OTLP_ENDPOINT` at MODULE LOAD
 * time and `buildMetricReaders()` is not exported, so there is no seam to
 * invoke that branch directly. A cache-busting dynamic re-import (the
 * pattern instrument.test.ts uses for `resolveRelease()`) does NOT work
 * here: unlike `resolveRelease()`, which is a pure function with no
 * side effects, re-importing otel.ts a second time re-runs
 * `metrics.setGlobalMeterProvider(...)` — but OTel's API only honors the
 * FIRST successful global registration per process and silently no-ops
 * every subsequent call. A second import's `getMeter()` would therefore
 * still delegate to whichever MeterProvider won registration first
 * (possibly from an entirely different test file's earlier import in the
 * same `bun test` process), not to the second import's own
 * `buildMetricReaders()` output — making any observed "difference"
 * between the two imports meaningless.
 *
 * FINDING: only the endpoint-unset branch is realistically testable
 * without changing otel.ts's exports. The "returns a Meter that records
 * without throwing" tests above already cover that branch (this repo's
 * test env has no OTEL_EXPORTER_OTLP_ENDPOINT set — see .env.example /
 * deploy/secrets.env.example, both commented out by default). Covering
 * the endpoint-set branch would require otel.ts to export
 * `buildMetricReaders` (or an equivalent seam) for direct unit testing —
 * that is a production-code change outside this test-backfill task's
 * scope, so it is left as a finding rather than forced via a brittle
 * env-toggle + module-reimport test.
 */
