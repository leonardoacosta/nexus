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
    parentSessionId: null,
    childRole: null,
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
};

// ---------------------------------------------------------------------------
// Stub server
// ---------------------------------------------------------------------------

export interface StubAgentOptions {
  /**
   * Host to bind. Defaults to an auto-discovered non-loopback IPv4. Passing a
   * loopback-ish host throws (enforced spec scenario).
   */
  host?: string;
  /** Port to bind. Defaults to an OS-assigned ephemeral port (0). */
  port?: number;
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
export function startStubAgent(opts: StubAgentOptions = {}): StubAgentHandle {
  const host = opts.host ?? discoverNonLoopbackIPv4();

  if (isLoopbackish(host)) {
    throw new Error(
      `stub-agent: refusing to bind loopback-ish host "${host}". macOS ATS ` +
        `exempts loopback / *.local from its cleartext policy, which would ` +
        `false-green the -1022 transport fault. Bind a real LAN/Tailscale IPv4.`,
    );
  }

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const server = Bun.serve({
    hostname: host,
    port: opts.port ?? 0,
    fetch(req: Request): Response {
      const { pathname } = new URL(req.url);
      switch (pathname) {
        case "/sessions":
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
