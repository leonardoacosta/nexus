/**
 * Reusable stub-agent harness for the client-transport integration tier.
 *
 * Spec: add-fullstack-integration-test-gate task 1.4.
 *
 * Why this exists
 * ---------------
 * The macOS client-transport gate must reproduce the ATS `-1022` cleartext
 * fault faithfully. macOS App Transport Security EXEMPTS loopback and
 * `*.local` from its cleartext policy — so a stub bound to `127.0.0.1`
 * (or `localhost` / `::1` / a `.local` mDNS name) would let the real `.app`
 * succeed even when its ATS policy is wrong, producing a FALSE GREEN for the
 * exact fault class this suite guards. Therefore this harness MUST bind a
 * NON-loopback address (the machine's LAN / Tailscale IPv4) and MUST throw
 * fast at setup if handed a loopback-ish host. This is an enforced spec
 * scenario, not a soft preference.
 *
 * Mock-drift mitigation
 * ---------------------
 * The fixtures below were snapshotted from the REAL running agent's
 * `/sessions`, `/health`, and `/events` responses (against a throwaway PG)
 * and are statically typed against the canonical contracts:
 *   - `/sessions`  → `SessionRow[]`        (apps/agent db/sessions — $inferSelect)
 *   - `/events`    → `SessionEventRow[]`   (apps/agent db/events   — $inferSelect)
 *   - `/health`    → `HealthMetrics`       (@nexus/core)
 * If any of those contracts drift, this file fails to type-check — the
 * fixtures cannot silently diverge from the production response shape.
 */

import type { HealthMetrics } from "@nexus/core";
import type { SessionRow } from "../db/sessions";
import type { SessionEventRow } from "../db/events";

// ---------------------------------------------------------------------------
// Loopback guard — enforced spec scenario
// ---------------------------------------------------------------------------

/**
 * Hosts that macOS ATS exempts from its cleartext policy. Binding the stub
 * to any of these would false-green the `-1022` transport fault, so they are
 * rejected at setup with a `throw`.
 */
const LOOPBACK_LITERALS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True when `host` is loopback-ish (literal loopback or any `*.local` mDNS name). */
export function isLoopbackish(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (LOOPBACK_LITERALS.has(h)) return true;
  if (h === "0.0.0.0" || h === "::") return true; // wildcard binds include loopback
  if (h.endsWith(".local")) return true; // mDNS — ATS-exempt like loopback
  if (h.startsWith("127.")) return true; // entire 127.0.0.0/8 is loopback
  return false;
}

/**
 * Discover a usable NON-loopback IPv4 for this machine (LAN or Tailscale).
 * Prefers a private LAN address (10/172.16/192.168), then falls back to the
 * Tailscale CGNAT range (100.64/10), then any other non-internal IPv4.
 */
export function discoverNonLoopbackIPv4(): string {
  // Bun re-exports the Node `os` module.
  const os = require("node:os") as typeof import("node:os");
  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (isLoopbackish(addr.address)) continue;
      candidates.push(addr.address);
    }
  }
  const isPrivateLan = (ip: string) =>
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const isTailscale = (ip: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);

  const lan = candidates.find(isPrivateLan);
  if (lan) return lan;
  const ts = candidates.find(isTailscale);
  if (ts) return ts;
  const any = candidates[0];
  if (any) return any;
  throw new Error(
    "stub-agent: no non-loopback IPv4 interface found — cannot reproduce ATS faithfully",
  );
}

// ---------------------------------------------------------------------------
// Deterministic fixtures — snapshotted from the real agent's response shapes
// ---------------------------------------------------------------------------

const FIXED_NOW = "2026-05-19T11:04:02.740Z";

/**
 * `GET /sessions` fixture. Shape verified against the live agent: a full
 * `sessions.$inferSelect` row with every column present. Typed as
 * `SessionRow[]` so a schema column add/remove breaks compilation here.
 */
export const SESSIONS_FIXTURE: SessionRow[] = [
  {
    id: "stub-sess-1",
    projectId: null,
    machine: "stub-machine",
    status: "active",
    startedAt: new Date(FIXED_NOW),
    lastActivity: new Date(FIXED_NOW),
    endedAt: null,
    stopReason: null,
    errorDetails: null,
    pid: 4242,
    cwd: "/tmp/stub",
    branch: null,
    sessionType: "managed",
    model: "claude",
    rateLimitUtilization: null,
    totalCostUsd: null,
    rateLimitResetAt: null,
    idleSince: null,
    ccSessionId: null,
    tmuxSession: null,
    tmuxTarget: null,
    spec: null,
    credentialId: null,
    credentialFingerprint: null,
    gitProvider: null,
    gitOwnerRepo: null,
    agentState: null,
    parentSessionId: null,
    childRole: null,
  },
  // Child subagent row (child of stub-sess-1). Populates the six previously
  // Swift-drifted columns with non-null values so the Swift contract test
  // (SessionDecodingTests.testDecodesSubagentTreeAndCredentialFields) can
  // assert they decode to real values. Every column is present because the
  // array is typed `SessionRow[]` — a schema add/remove breaks compilation.
  {
    id: "stub-sess-2-child",
    projectId: null,
    machine: "stub-machine",
    status: "active",
    startedAt: new Date(FIXED_NOW),
    lastActivity: new Date(FIXED_NOW),
    endedAt: null,
    stopReason: null,
    errorDetails: null,
    pid: 4243,
    cwd: "/tmp/stub",
    branch: null,
    sessionType: "ad_hoc",
    model: "claude",
    rateLimitUtilization: 0.42,
    totalCostUsd: null,
    rateLimitResetAt: null,
    idleSince: null,
    ccSessionId: null,
    tmuxSession: null,
    tmuxTarget: null,
    spec: "add-subagent-tree-columns",
    credentialId: "cred-personal",
    credentialFingerprint: "fp-aaaa",
    gitProvider: null,
    gitOwnerRepo: null,
    agentState: null,
    parentSessionId: "stub-sess-1",
    childRole: "explore",
  },
];

/**
 * `GET /events` fixture. Shape verified against the live agent:
 * `sessionEvents.$inferSelect` rows. Typed as `SessionEventRow[]`.
 */
export const EVENTS_FIXTURE: SessionEventRow[] = [
  {
    id: 1,
    sessionId: "stub-sess-1",
    eventType: "PreToolUse",
    timestamp: new Date(FIXED_NOW),
    metadata: JSON.stringify({ tool: "Bash" }),
  },
];

/**
 * `GET /health` fixture. Shape verified against the live agent's
 * `HealthMetrics` payload (detail=true variant — includes the optional
 * `network` and `processes` blocks). Typed as `HealthMetrics`.
 */
export const HEALTH_FIXTURE: HealthMetrics = {
  hostname: "stub-host",
  uptime_seconds: 938551,
  collectedAt: FIXED_NOW,
  cpu: {
    overall_percent: 12.5,
    per_core_percent: [10, 12, 14, 8],
    load_average: [1.2, 1.1, 1.0],
  },
  ram: {
    total_bytes: 17179869184,
    used_bytes: 8589934592,
    percent: 50,
  },
  disk: [
    {
      mount: "/",
      total_bytes: 494384795648,
      used_bytes: 17770647552,
      percent: 57.1,
    },
  ],
  docker: { containers: 0, running: 0 },
  network: [{ iface: "en0", rx_bytes: 1000, tx_bytes: 2000 }],
  processes: {
    top_cpu: [
      { pid: 4242, name: "claude", cpu_percent: 12.5, ram_percent: 1.6 },
    ],
    top_ram: [
      { pid: 4242, name: "claude", cpu_percent: 12.5, ram_percent: 1.6 },
    ],
  },
  // Liveness fields — stub fixture defaults to "healthy" so dashboards
  // exercising the stub agent see a green liveness signal.
  db_ok: true,
  last_watcher_tick_ms: 0,
  socket_server_listening: true,
};

// ---------------------------------------------------------------------------
// Stub server
// ---------------------------------------------------------------------------

/**
 * A controlled `NotificationFired` payload the stub emits on `/events/stream`.
 *
 * Mirrors the agent's real `NotificationFired` SSE frame shape (see
 * apps/agent/src/routes/events-sse.ts + the lifecycle bus). The Swift
 * `SSEEvent.decodeNotification()` reads `body`/`channel`/`title`/`emoji` from
 * either the envelope top-level OR a nested `payload` — this fixture writes
 * them top-level (the canonical shape) and `body` is required non-empty.
 *
 * Spec: mac-tts-integration-test (task 1.1) — the deterministic
 * `NotificationFired -> Swift TTS playback` round-trip harness drives this.
 */
export interface StubNotificationFired {
  /** Required, non-empty — decodeNotification() drops empty-body frames. */
  body: string;
  /** "tts" exercises the synth/audio path; "desktop" is banner-only. */
  channel?: string;
  title?: string;
  emoji?: string;
  /** Project slug — primes the observer's per-project voice resolution. */
  project?: string;
}

export interface StubAgentOptions {
  /**
   * Host to bind. Defaults to an auto-discovered non-loopback IPv4. Passing a
   * loopback-ish host throws (enforced spec scenario).
   */
  host?: string;
  /** Port to bind. Defaults to an OS-assigned ephemeral port (0). */
  port?: number;
  /**
   * Allow binding a loopback host. Defaults to false (the ATS `-1022` guard).
   *
   * The mac-tts-integration-test harness drives the SSE round-trip against a
   * loopback stub — that test is NOT the client-transport ATS gate (it does
   * not assert cleartext-policy faults), so the loopback exemption is exactly
   * what we want. Setting this true disables the loopback throw so the SSE
   * round-trip can run on `127.0.0.1` deterministically.
   */
  allowLoopback?: boolean;
  /**
   * When set, `GET /events/stream` emits a single `NotificationFired` SSE
   * frame built from this fixture, then holds the connection open (a real
   * SSE stream stays live; the client closes it). When unset, the stub does
   * not register the SSE route and `/events/stream` 404s.
   */
  notificationFired?: StubNotificationFired;
}

export interface StubAgentHandle {
  /** The non-loopback host the stub bound to. */
  readonly host: string;
  /** The resolved port. */
  readonly port: number;
  /** `http://host:port` — the base URL a client should be pointed at. */
  readonly baseUrl: string;
  /** Stop the stub server. Safe to call once. */
  stop(): void;
}

/**
 * Start the stub agent.
 *
 * @throws if `host` (explicit or discovered) is loopback-ish — the harness
 * refuses to bind there because macOS ATS would exempt it and produce a
 * false-green for the `-1022` client-transport fault.
 */
/**
 * Serialize a `NotificationFired` fixture into an SSE frame body.
 *
 * Emits the canonical agent wire shape:
 *   `event: NotificationFired\ndata: <json>\n\n`
 * The JSON carries `body`/`channel`/`title`/`emoji`/`project` top-level, which
 * `SSEEvent.decodeNotification()` reads directly (it also accepts a nested
 * `payload`, but top-level is the canonical form).
 *
 * Exported so the TS harness test can assert the emitted frame shape without
 * standing up the HTTP server.
 */
export function encodeNotificationFiredFrame(n: StubNotificationFired): string {
  const payload: Record<string, unknown> = {
    id: "stub-notif-1",
    body: n.body,
    created_at: FIXED_NOW,
  };
  if (n.channel !== undefined) payload.channel = n.channel;
  if (n.title !== undefined) payload.title = n.title;
  if (n.emoji !== undefined) payload.emoji = n.emoji;
  if (n.project !== undefined) payload.project = n.project;
  return `event: NotificationFired\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function startStubAgent(opts: StubAgentOptions = {}): StubAgentHandle {
  const host = opts.host ?? discoverNonLoopbackIPv4();

  if (isLoopbackish(host) && !opts.allowLoopback) {
    throw new Error(
      `stub-agent: refusing to bind loopback-ish host "${host}". macOS ATS ` +
        `exempts loopback / *.local from its cleartext policy, which would ` +
        `false-green the -1022 transport fault. Bind a real LAN/Tailscale IPv4. ` +
        `(Pass allowLoopback:true for the mac-tts SSE round-trip harness, which ` +
        `is not the ATS client-transport gate.)`,
    );
  }

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  /** Build the SSE response that emits one NotificationFired frame then holds. */
  const sseResponse = (n: StubNotificationFired): Response => {
    const frame = encodeNotificationFiredFrame(n);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame));
        // A real SSE connection stays open; the client closes it. We do NOT
        // close the controller so the consumer keeps the pipe live (and the
        // single emitted frame is the deterministic event under test).
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  };

  const server = Bun.serve({
    hostname: host,
    port: opts.port ?? 0,
    fetch(req: Request): Response {
      const url = new URL(req.url);
      const { pathname } = url;
      switch (pathname) {
        case "/events/stream":
          if (opts.notificationFired) {
            return sseResponse(opts.notificationFired);
          }
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        case "/sessions":
          // The REAL client transport (NexusClient.fetchSessions) always
          // requests `/sessions?withFingerprint=true`. For that path we
          // advance startedAt/lastActivity to "now" (every other field
          // byte-identical to SESSIONS_FIXTURE — still typed
          // SessionRow[], NOT a divergent fixture). A plain `/sessions`
          // with no query returns the exact snapshot, so the API-batch
          // stub-agent.test.ts deep-equal assertion stays green. Fresh
          // timestamps are required because SessionObserver.activeSessions
          // filters rows whose lastActivity is older than 300s — a
          // hardcoded FIXED_NOW goes stale within minutes and would paint
          // an empty dashboard even on a *successful* round-trip
          // (false-red for the transport guard, bd:nx-68ulr).
          if (url.searchParams.get("withFingerprint") === "true") {
            const now = new Date();
            return json(
              SESSIONS_FIXTURE.map((row) => ({
                ...row,
                startedAt: now,
                lastActivity: now,
              })),
            );
          }
          return json(SESSIONS_FIXTURE);
        case "/health":
          return json(HEALTH_FIXTURE);
        case "/events":
          return json(EVENTS_FIXTURE);
        default:
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
      }
    },
  });

  const resolvedPort = server.port ?? opts.port ?? 0;
  return {
    host,
    port: resolvedPort,
    baseUrl: `http://${host}:${resolvedPort}`,
    stop() {
      server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint — for the XCUITest client-transport round-trip (spec 2.4)
// ---------------------------------------------------------------------------
//
// `bun apps/agent/src/testing/stub-agent.ts` starts the stub on an
// auto-discovered NON-loopback IPv4 (the loopback guard still applies) and
// prints a single `STUB_BASE_URL=http://<ip>:<port>` line to stdout so the
// XCUITest harness can read it and point the app's
// `nexus.dashboard.endpoint` UserDefault at it. Runs until killed
// (SIGTERM/SIGINT) — the test owns lifecycle. `import.meta.main` guards
// this so importing the module (the API-batch unit tests) stays inert.
if (import.meta.main) {
  const handle = startStubAgent();
  process.stdout.write(`STUB_BASE_URL=${handle.baseUrl}\n`);
  const shutdown = () => {
    handle.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
