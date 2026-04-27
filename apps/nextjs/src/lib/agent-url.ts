/**
 * Agent base URL resolver with failover-aware probing.
 *
 * Single source of truth for `http://<host>:<port>` URLs pointing at a
 * reachable nexus-agent. Walks the DB-backed agent registry in order
 * (`getAgentConfigs()` in `./get-client.ts`) and returns the first agent
 * whose `/version` endpoint responds with a 2xx and a well-formed payload.
 *
 * Capability validation (matching against `EXPECTED_CAPABILITIES`) lives
 * in `agent-reachability.ts`, NOT here — `probeAgentRegistry()` only
 * requires a 2xx with valid shape so it can be reused by callers that
 * don't care about capabilities (SSE proxy, simple URL resolution).
 *
 * NAMING NOTE — `probeAgentRegistry()` (this file) is the low-level
 * registry walk. The capability-aware export in `agent-reachability.ts` is
 * named `probeAgents()` (reserved for callers). The two are intentionally
 * different to disambiguate the layers.
 *
 * The legacy `getAgentBaseUrl()` export remains as a back-compat shim for
 * callers that haven't migrated to the failover-aware contract.
 */

import { fetchWithTimeout } from "@nexus/core/fetch";
import type { AgentConfig } from "@nexus/core/node";
import { getAgentConfigs } from "./get-client";

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Result of resolving a single reachable agent.
 *
 * `baseUrl` is always a full `http://host:port` string (no trailing slash).
 * `agent` is the `AgentConfig` the base URL was derived from and is useful
 * for attaching the agent name to error messages.
 */
export interface AgentBaseUrlResolution {
  baseUrl: string;
  agent: AgentConfig;
}

/**
 * Per-agent probe result captured for diagnostics. The full ordered list
 * (one entry per attempted agent up to and including the responder) is
 * returned on the success path so callers can log "we skipped N agents
 * before <name> answered".
 *
 * Outcomes:
 *   ok          → 2xx with valid `{ buildSha, builtAt, capabilities }`
 *                 shape. The parsed `payload` is attached so the
 *                 capability-layer (`agent-reachability.ts`) can run its
 *                 `EXPECTED_CAPABILITIES` check without re-fetching.
 *   timeout     → AbortError, network failure, or `fetchWithTimeout` timeout
 *   http-error  → reached the agent but it returned non-2xx
 *   bad-shape   → 2xx but JSON missing fields or wrong types — treated as
 *                 transport failure so the walk continues
 */
export type ProbeAttempt = { agent: AgentConfig } & (
  | { outcome: "ok"; payload: VersionPayload }
  | { outcome: "timeout" }
  | { outcome: "http-error"; status: number }
  | { outcome: "bad-shape" }
);

/**
 * Discriminated union returned by `probeAgentRegistry()`.
 *
 *   ok: true                     → first responder found; `peers` is the
 *                                  ordered tail of agents AFTER the responder
 *                                  (used for transparent retries by
 *                                  `withFailover`); `firstResponderIndex` is
 *                                  the zero-based position in the original
 *                                  DB-ordered list (0 = no failover);
 *                                  `payload` is the parsed `/version` body
 *                                  from the responder (so the capability
 *                                  layer can avoid a second round-trip).
 *   reason: "no-agent"           → registry empty (theoretically impossible
 *                                  given the localhost fallback in
 *                                  `getAgentConfigs()`, but defended anyway)
 *   reason: "all-failed"         → walked the entire registry, none answered;
 *                                  `attempts` carries one entry per agent so
 *                                  callers can render diagnostic banners
 */
export type ProbeResult =
  | {
      ok: true;
      active: AgentBaseUrlResolution;
      peers: AgentConfig[];
      firstResponderIndex: number;
      attempts: ProbeAttempt[];
      payload: VersionPayload;
    }
  | { ok: false; reason: "no-agent" }
  | { ok: false; reason: "all-failed"; attempts: ProbeAttempt[] };

interface ProbeOptions {
  /** Per-agent timeout in ms (default 5_000). */
  timeoutMs?: number;
  /**
   * Resume the walk at this zero-based index of the DB-ordered registry.
   * Used by the capability layer to skip past a stale responder and look
   * for a healthy peer. Defaults to 0 (start from the top).
   *
   * If `startIndex >= configs.length` the call returns `no-agent` (the
   * registry effectively empty from the caller's vantage point). Indices
   * before `startIndex` are NOT included in `attempts` — the resume call
   * only reports what it actually probed.
   */
  startIndex?: number;
}

export interface VersionPayload {
  buildSha: string;
  builtAt: string;
  capabilities: string[];
}

/**
 * Validate that a `/version` JSON payload has the expected shape.
 *
 * Capability validation against `EXPECTED_CAPABILITIES` is intentionally
 * NOT done here — `agent-reachability.ts` layers that on top of this
 * primitive.
 */
function isVersionPayload(value: unknown): value is VersionPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.buildSha === "string" &&
    typeof v.builtAt === "string" &&
    Array.isArray(v.capabilities) &&
    v.capabilities.every((c): c is string => typeof c === "string")
  );
}

/**
 * Walk the DB-ordered agent registry and return the first reachable agent.
 *
 * Each agent is probed against `GET /version` with a per-agent timeout
 * (default 5s). The walk stops on the first 2xx + valid shape. Network
 * errors, timeouts, non-2xx responses, and malformed payloads all flow
 * through to the next agent — this function never throws.
 *
 * Returns a `ProbeResult` discriminated union; callers should `switch` on
 * `ok` / `reason` and avoid try/catch.
 *
 * NAMING — this is the registry-level walk. The capability-aware export
 * (`probeAgents()` in `agent-reachability.ts`) layers an
 * `EXPECTED_CAPABILITIES` check on top of this primitive.
 */
export async function probeAgentRegistry(
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const startIndex = opts.startIndex ?? 0;
  const configs = await getAgentConfigs();
  if (configs.length === 0 || startIndex >= configs.length) {
    return { ok: false, reason: "no-agent" };
  }

  const attempts: ProbeAttempt[] = [];

  for (let i = startIndex; i < configs.length; i++) {
    const agent = configs[i]!;
    const baseUrl = `http://${agent.host}:${agent.port}`;

    try {
      const res = await fetchWithTimeout(`${baseUrl}/version`, {
        timeout: timeoutMs,
        cache: "no-store",
      });

      if (!res.ok) {
        attempts.push({ agent, outcome: "http-error", status: res.status });
        continue;
      }

      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        // Body wasn't JSON — treat as bad shape rather than http-error so
        // the walk continues and the failure mode is named accurately.
        attempts.push({ agent, outcome: "bad-shape" });
        continue;
      }

      if (!isVersionPayload(payload)) {
        attempts.push({ agent, outcome: "bad-shape" });
        continue;
      }

      // First responder. Record the ok attempt (with the parsed payload so
      // the capability layer doesn't need to re-fetch), build peers from
      // the ordered tail, and return.
      attempts.push({ agent, outcome: "ok", payload });
      const peers = configs.slice(i + 1);
      return {
        ok: true,
        active: { baseUrl, agent },
        peers,
        firstResponderIndex: i,
        attempts,
        payload,
      };
    } catch {
      // fetchWithTimeout throws on timeout / network failure / abort. We
      // collapse all transport-level errors into "timeout" for the
      // diagnostic — the user-facing distinction is "we couldn't talk to
      // this agent" and we already have the agent in scope.
      attempts.push({ agent, outcome: "timeout" });
      continue;
    }
  }

  return { ok: false, reason: "all-failed", attempts };
}

/**
 * Resolve the agent base URL from the DB-backed agent registry.
 *
 * @deprecated Prefer `probeAgents()` (in `agent-reachability.ts`) for
 * failover- and capability-aware resolution. This shim preserves the
 * pre-failover synchronous DB→config behavior: returns the first
 * enabled agent without any network probe. Callers that need
 * reachability or failover semantics MUST migrate to `probeAgents()`.
 */
export async function getAgentBaseUrl(): Promise<AgentBaseUrlResolution | null> {
  const configs = await getAgentConfigs();
  const agent = configs[0];
  if (!agent) return null;
  return { baseUrl: `http://${agent.host}:${agent.port}`, agent };
}
