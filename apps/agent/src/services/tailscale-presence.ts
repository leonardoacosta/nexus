/**
 * Tailscale presence poller (openspec/changes/mac-presence-observer, Phase 1.5).
 *
 * A low-frequency poller that shells `tailscale status --json`, finds the user's
 * phone peer, classifies its reachability, and reports `phonePresent` /
 * `phoneHome` into the agent-held presence vector. This derives a home/away
 * signal with ZERO iOS permission — it runs entirely on the always-on agent.
 *
 * Classification (spec § Tailscale Home Detection):
 *   - a phone peer reachable via a LAN-range (RFC1918) DIRECT endpoint (its
 *     `CurAddr`) is HOME (`phoneHome: true, phonePresent: true`);
 *   - a phone reachable only via a public address or a DERP relay is AWAY
 *     (`phoneHome: false, phonePresent: true`);
 *   - an absent/offline phone is NOT PRESENT (`phonePresent: false`,
 *     `phoneHome: null` — home is indeterminate).
 *
 * The classifier `classifyPhonePeer` is PURE and exported so the
 * decision logic is unit-testable without shelling out. The poller is the thin
 * IO wrapper: shell → parse → classify → report. A failed `tailscale status`
 * call logs a warn and retries on the next tick — it NEVER crashes the agent
 * and NEVER reports a stale value (the presence-context TTL collapses the
 * fields to `unknown` after `PHONE_FIELD_TTL_MS` if ticks stop landing).
 *
 * Phone-peer identification: the iOS Tailscale client frequently reports
 * `HostName: "localhost"`, so a single configurable match string
 * (`NEXUS_PHONE_PEER`, default `"iphone"`) is tested against the peer's
 * `HostName`, its `DNSName`, and each of its `TailscaleIPs` (substring,
 * case-insensitive). Set `NEXUS_PHONE_PEER` to a stable per-device `100.x`
 * Tailscale IP when the hostname is the generic `localhost`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "@nexus/core/node";
import { getPresenceContext } from "../notifications/presence-context";

const execFileAsync = promisify(execFile);
const log = createLogger("agent:services:tailscale-presence");

/** Default poll interval (a few seconds). Override via `NEXUS_TAILSCALE_POLL_MS`. */
const DEFAULT_INTERVAL_MS = 5_000;

/** Per-call timeout for `tailscale status --json`. */
const STATUS_TIMEOUT_MS = 4_000;

/** Default phone-peer match string. Override via `NEXUS_PHONE_PEER`. */
const DEFAULT_PHONE_MATCH = "iphone";

// ── Minimal `tailscale status --json` shape (only what we read) ─────────────

/** A single peer entry from `tailscale status --json`. Defensive / partial. */
export interface TailscalePeer {
  HostName?: string;
  DNSName?: string;
  OS?: string;
  Online?: boolean;
  /** The current DIRECT endpoint `ip:port`, empty when relayed. */
  CurAddr?: string;
  /** The DERP relay region code, empty/absent when directly connected. */
  Relay?: string;
  /** The peer's tailnet IPs (100.x + IPv6). */
  TailscaleIPs?: string[];
}

/** The subset of `tailscale status --json` the poller consumes. */
export interface TailscaleStatus {
  Self?: TailscalePeer;
  Peer?: Record<string, TailscalePeer>;
}

/** The classified phone-presence result merged into the vector. */
export interface PhonePresence {
  /** True when the phone peer is reachable on the tailnet. */
  phonePresent: boolean;
  /** True = home, false = away, null = indeterminate (not present). */
  phoneHome: boolean | null;
}

// ── Pure classification (unit-testable, no IO) ──────────────────────────────

/** Is `ip` an RFC1918 private (LAN-range) IPv4 address? */
function isRfc1918(ip: string): boolean {
  // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  const m = /^172\.(\d{1,3})\./.exec(ip);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

/** Strip the `:port` suffix from an `ip:port` endpoint (IPv4 only). */
function hostFromEndpoint(endpoint: string): string {
  // IPv4 `a.b.c.d:port` — take everything before the last colon.
  const idx = endpoint.lastIndexOf(":");
  return idx === -1 ? endpoint : endpoint.slice(0, idx);
}

/** Does this peer match the configured phone identifier (case-insensitive substring)? */
function peerMatches(peer: TailscalePeer, match: string): boolean {
  const needle = match.toLowerCase();
  const haystacks: string[] = [];
  if (peer.HostName) haystacks.push(peer.HostName);
  if (peer.DNSName) haystacks.push(peer.DNSName);
  if (peer.TailscaleIPs) haystacks.push(...peer.TailscaleIPs);
  return haystacks.some((h) => h.toLowerCase().includes(needle));
}

/**
 * Classify the phone peer's home/away/absent state from a parsed
 * `tailscale status`. PURE — no IO, no env reads. `match` is the phone-peer
 * identifier (substring tested against HostName / DNSName / TailscaleIPs).
 *
 * When multiple peers match (e.g. the same iPhone re-registered), an ONLINE
 * peer is preferred over an offline one so a stale offline ghost never masks a
 * live device.
 */
export function classifyPhonePeer(
  status: TailscaleStatus,
  match: string,
): PhonePresence {
  const peers = Object.values(status.Peer ?? {});
  const matched = peers.filter((p) => peerMatches(p, match));

  if (matched.length === 0) {
    return { phonePresent: false, phoneHome: null };
  }

  // Prefer an online peer; fall back to the first match otherwise.
  const peer = matched.find((p) => p.Online === true) ?? matched[0]!;

  if (peer.Online !== true) {
    return { phonePresent: false, phoneHome: null };
  }

  // Online and reachable → present. Home iff the DIRECT endpoint is RFC1918.
  const curAddr = peer.CurAddr ?? "";
  const directHost = curAddr ? hostFromEndpoint(curAddr) : "";
  const home = directHost !== "" && isRfc1918(directHost);

  return { phonePresent: true, phoneHome: home };
}

// ── Poller service (the IO wrapper) ─────────────────────────────────────────

/** Service handle returned from `startTailscalePresencePoller`. */
export interface TailscalePresencePollerService {
  stop(): void;
  /** Exposed for tests — run one tick synchronously and await its result. */
  tickOnce(): Promise<PhonePresence | null>;
}

export interface StartTailscalePresencePollerOpts {
  /** Override the poll interval (testing + env var). */
  intervalMs?: number;
  /** Override the phone-peer match string (testing + env var). */
  phoneMatch?: string;
  /**
   * Override the status fetcher (testing). Defaults to shelling
   * `tailscale status --json`. Returns the parsed status, or null on failure.
   */
  fetchStatus?: () => Promise<TailscaleStatus | null>;
}

/** Shell `tailscale status --json` and parse it. Returns null on any failure. */
async function defaultFetchStatus(): Promise<TailscaleStatus | null> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      timeout: STATUS_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout) as TailscaleStatus;
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "tailscale status --json failed — will retry next tick",
    );
    return null;
  }
}

/**
 * Start the Tailscale presence poller. On each tick it fetches + classifies the
 * phone peer and reports `phonePresent`/`phoneHome` into the presence context
 * with source `derived`. A failed fetch reports nothing (the field's TTL
 * eventually collapses it to `unknown`) and never throws.
 */
export function startTailscalePresencePoller(
  opts: StartTailscalePresencePollerOpts = {},
): TailscalePresencePollerService {
  const envInterval = Number(process.env.NEXUS_TAILSCALE_POLL_MS);
  const intervalMs =
    opts.intervalMs ??
    (Number.isFinite(envInterval) && envInterval > 0
      ? envInterval
      : DEFAULT_INTERVAL_MS);
  const phoneMatch =
    opts.phoneMatch ?? process.env.NEXUS_PHONE_PEER ?? DEFAULT_PHONE_MATCH;
  const fetchStatus = opts.fetchStatus ?? defaultFetchStatus;

  let stopped = false;

  async function tickOnce(): Promise<PhonePresence | null> {
    let status: TailscaleStatus | null;
    try {
      status = await fetchStatus();
    } catch (err) {
      // fetchStatus is contracted to swallow, but guard anyway — never crash.
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "tailscale presence fetch threw — skipping tick",
      );
      return null;
    }
    if (!status) return null;

    let result: PhonePresence;
    try {
      result = classifyPhonePeer(status, phoneMatch);
    } catch (err) {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "tailscale presence classify failed — skipping tick",
      );
      return null;
    }

    // Report present/home; when the phone is absent, report phonePresent:false
    // but DO NOT assert phoneHome (it is indeterminate — leave it to TTL/unknown).
    const report: { phonePresent: boolean; phoneHome?: boolean } = {
      phonePresent: result.phonePresent,
    };
    if (result.phoneHome !== null) report.phoneHome = result.phoneHome;

    getPresenceContext().report(report, "derived");
    log.debug(result, "tailscale presence: reported");
    return result;
  }

  // Fire immediately, then on the interval. setInterval errors are swallowed by
  // the per-tick try/catch above; the interval itself never carries a rejection.
  void tickOnce();
  const timer = setInterval(() => {
    if (stopped) return;
    void tickOnce();
  }, intervalMs);
  // Don't keep the event loop alive solely for this poller.
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tickOnce,
  };
}
