# Design: Wire nexus-agent into the Grafana OTel Stack

## Current state (verified against live code, 2026-07-14)

```
apps/agent/src/index.ts
  import "./otel"          # side-effecting: registers a global NodeTracerProvider
  import "./instrument"     # Sentry, no-ops when SENTRY_DSN unset

apps/agent/src/otel.ts
  NodeTracerProvider (sdk-trace-node, NOT sdk-node — chosen so `bun build --compile` stays happy)
  resource: { service.name: OTEL_SERVICE_NAME ?? "nexus" }
  spanProcessors:
    - OTEL_EXPORTER_OTLP_ENDPOINT set   -> BatchSpanProcessor(OTLPTraceExporter())
    - otherwise                          -> SimpleSpanProcessor(ConsoleSpanExporter())  # dev fallback, silently what prod gets today
  provider.register()   # wires @opentelemetry/api's global `trace`
  export function getTracer(): Tracer

  getTracer() consumers today:
    - apps/agent/src/services/socket-server/dispatcher.ts:38 (startActiveSpan around WS message handling)
    - apps/agent/src/credentials/pool/pool-core.ts (credential rotation spans)
  NOT wrapped: all 106 HTTP routes (server-request-handler.ts's if-chain dispatch)

packages/core/src/logger.ts
  buildMixin()      -> reads trace.getSpan(context.active()), injects traceId/spanId — CORRECT, keep
  buildTransport()  -> pino-opentelemetry-transport worker, ACTIVE when OTEL_EXPORTER_OTLP_ENDPOINT set
                       — this is the pattern the fleet Observability Canon retired 2026-07-12
                       (ct's Next.js incident: thread-stream worker path resolution breaks under
                       webpack bundling). nexus-agent is Bun, not webpack-bundled, so it may not
                       hit the identical ERR_INVALID_ARG_TYPE crash — but the canon bans the
                       *pattern*, not just the one crash, and running a second fleet repo on the
                       retired shape defeats the point of having a canon. Migrate regardless.

No MeterProvider anywhere. No metrics export at all today — traces only.
```

## Target shape

```
                    ┌─────────────────────────────────────────┐
                    │  nexus-agent (Bun, per-machine daemon)   │
                    │                                           │
                    │  otel.ts                                  │
                    │   ├─ NodeTracerProvider (existing)        │
                    │   │    spans: WS dispatch, credential     │
                    │   │    rotation, + NEW: HTTP dispatch      │
                    │   └─ MeterProvider (NEW)                  │
                    │        gauges: cpu/mem/disk/docker,       │
                    │        recorded on HealthCollector's       │
                    │        existing 5s tick (no new poller)   │
                    │                                           │
                    │  logger.ts: plain stdout + mixin only     │
                    │  (pino-opentelemetry-transport removed)   │
                    └───────────────┬───────────────────────────┘
                                    │ OTLP/HTTP (traces + metrics)
                    ┌───────────────┴───────────────────────────┐
                    │ homelab host?                              │
                    │  YES -> http://localhost:4318, no auth     │
                    │  NO  -> https://otlp.leonardoacosta.dev,   │
                    │         Authorization: Basic <...>         │
                    │         (OTEL_EXPORTER_OTLP_HEADERS)       │
                    └───────────────┬───────────────────────────┘
                                    ▼
                    hl LGTM stack (already deployed, homelab repo):
                    Alloy (OTLP receiver) -> Tempo (traces) / VictoriaMetrics (metrics)
                    -> Grafana @ grafana.leonardoacosta.dev
```

Logs stay on the existing path: plain stdout, picked up by the fleet log-drain mechanism
(`cc-06294`, tracked separately) or the homelab host's own Promtail/Alloy log scraping of the
systemd journal — nexus-agent does not need its own log-shipping transport per Recipe 3.

## Key decisions

1. **Metrics provider mirrors the trace provider's shape exactly.** Same file (`otel.ts`), same
   package family constraint (`@opentelemetry/sdk-metrics`, never `sdk-node`), same
   endpoint-presence gate, same `resourceFromAttributes` resource. This is a sibling addition,
   not a parallel abstraction — reviewers should see one obvious pattern extended, not two ways
   of configuring OTel in the same file.

2. **Reuse `HealthCollector`'s existing 5s tick for metrics, don't add a new interval.**
   `health-collector.ts` already gathers `currentLoad`/`mem`/`fsSize`/`dockerContainers` every
   `DEFAULT_INTERVAL_MS` (5000) and persists to Postgres. The metrics requirement hooks into the
   same collection callback to also record OTel gauges — one data-gathering cadence, two sinks
   (DB + OTLP), per the Reader Gate (extend, don't reinvent).

3. **HTTP tracing is a thin wrapper, not per-route instrumentation.** `createRequestHandler`'s
   `handleRequest` is the single chokepoint all 106 routes flow through (confirmed: it's the
   if-chain dispatcher). One `getTracer().startActiveSpan()` around the call, populated with
   `request.method` / `url.pathname` / the eventual `Response.status`, gives blanket HTTP trace
   coverage without touching any of the 103 individual route handler files. Full
   auto-instrumentation (`@opentelemetry/instrumentation-http`) is deliberately avoided — its
   Bun compatibility is unproven and the manual wrapper is simpler and provably correct.

4. **`service.name` changes from `"nexus"` to `"nexus-agent"`.** The current default
   (`OTEL_SERVICE_NAME ?? "nexus"`) is too generic — if a future cc-native-OTel-ingest Collector
   (per the archived `explore-native-otel-telemetry` exploration) ever lands on the same homelab
   box, "nexus" would collide with cc's own service identity in the same Grafana instance.
   Renaming the default now, while nothing depends on the old value in a dashboard yet, is the
   cheap time to do it.

5. **Logger migration is mechanical, not a rewrite.** `buildMixin()` is already correct and
   untouched. Only `buildTransport()` and its call site are deleted; the `transport` spread in
   the `pino({...})` call is removed. No new dependency, one fewer (`pino-opentelemetry-transport`
   can be dropped from `package.json` once nothing references it — verify via a repo-wide grep
   before removing the dependency itself, not just the code path).

6. **Basic-auth header lives on the exporter construction, not a new abstraction.**
   `new OTLPTraceExporter({ headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS) })` and
   the equivalent on the metrics exporter. A tiny inline parser (`key=value` split on the FIRST
   `=` only) is required — the canon's own footgun note warns that some SDK versions' env-var
   parsing splits on every `=`, corrupting base64 padding. Since we're constructing the exporter
   explicitly here (not relying on the SDK's own env-var auto-read), we control the parse and
   must get it right: split once, not globally.

## Explicit non-goals (cross-repo boundary)

- Adding nexus-agent as a Prometheus scrape target, a Grafana dashboard panel/folder, or an
  Alertmanager/Grafana-alerting rule — all homelab-repo (`~/dev/personal/homelab`), separate git
  remote. Whether a scrape target is even needed depends on whether Alloy's OTLP receiver
  already fans pushed metrics into VictoriaMetrics generically (by `service.name`, no static
  target list) — that's homelab-side to confirm, not assumed here. Tracked as a follow-up; a
  bead is filed cross-referencing this spec so the handoff isn't lost.
- Flipping `OTEL_EXPORTER_OTLP_ENDPOINT` on for real on any machine's live `~/.env` — that file
  is machine-local, gitignored, and edited by hand per `deploy/install.sh`'s own drift-check
  convention. This proposal ships the capability; turning it on is an operator action.
- Sentry removal (`apps/agent/src/instrument.ts`) — explicitly out of scope per the canon's own
  "separate downstream proposal" carve-out for deep migrations.

## Verification plan (GATE before calling this done)

1. Local smoke: run nexus-agent with `OTEL_EXPORTER_OTLP_ENDPOINT` unset — confirm console trace
   output unchanged, confirm metrics recorded locally (no crash), confirm logger output is plain
   JSON with no transport warning.
2. Local smoke: run against a throwaway `docker run otel/opentelemetry-collector` with a
   `debug` exporter, point `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` at it, confirm
   both trace AND metric records arrive (not just traces — metrics silently no-op'ing is the
   documented CC-side failure mode this design must not repeat on the nexus side).
3. `bun build --compile` still succeeds after adding `@opentelemetry/sdk-metrics` +
   `@opentelemetry/exporter-metrics-otlp-http` — this is the specific regression class `otel.ts`
   was already written to avoid for tracing; metrics packages need the same check.
4. Basic-auth header: `curl -H "Authorization: Basic <value>" -X POST
   https://otlp.leonardoacosta.dev/v1/traces` returns `200`, not `401`, before trusting the
   value in any deployed `.env`.
