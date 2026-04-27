/**
 * Agent reachability classifier.
 *
 * Probes `GET /version` on the local nexus-agent and classifies the result
 * into a discriminated union so the dashboard can render actionable banner
 * copy instead of collapsing every failure into "Agent unreachable".
 *
 * Spec: openspec/changes/agent-version-handshake/specs/dashboard-data-paths/spec.md
 */

import { fetchWithTimeout } from "@nexus/core/fetch";
import type { AgentConfig } from "@nexus/core/node";
import { getAgentBaseUrl } from "@/lib/agent-url";

const REACHABILITY_TIMEOUT_MS = 5_000;

/**
 * Build identity reported by the agent. `sha` is the short git SHA the agent
 * was built from; `at` is an ISO-8601 build timestamp. Both come straight
 * from the agent's `/version` payload.
 */
export interface AgentBuild {
  sha: string;
  at: string;
}

/**
 * Capabilities the dashboard requires the agent to support.
 *
 * If the agent's /version response is missing any of these, the
 * reachability classifier returns { ok: false, reason: "stale-binary" }.
 *
 * Add a new entry here when the dashboard starts depending on a new
 * agent endpoint. The underlying agent dispatcher must also serve it
 * (see LEGACY_DISPATCH_ROUTES in apps/agent/src/server-request-handler.ts).
 */
export const EXPECTED_CAPABILITIES: readonly string[] = [
  "GET /credentials",
  "GET /notifications/settings",
  "PATCH /notifications/settings",
] as const;

/**
 * Discriminated union returned by `probeAgent()`.
 *
 *   ok: true              → agent is reachable and serves every required capability
 *   reason: "no-agent"    → no enabled agent in the registry (DB-empty case)
 *   reason: "timeout"     → request aborted by the 5s timeout or network error
 *   reason: "stale-binary"→ agent reachable but missing capabilities listed in `missing`
 *   reason: "http-error"  → agent reachable but `/version` returned non-2xx or bad shape
 *
 * Failure variants carry the resolved `AgentConfig` so banner copy can name
 * the host:port the dashboard tried to reach. The `no-agent` variant has no
 * agent because none exists.
 */
export type Reachability =
  | { ok: true; build: AgentBuild; capabilities: string[]; agent: AgentConfig }
  | { ok: false; reason: "no-agent" }
  | { ok: false; reason: "timeout"; agent: AgentConfig }
  | {
      ok: false;
      reason: "stale-binary";
      build: AgentBuild;
      missing: string[];
      agent: AgentConfig;
    }
  | { ok: false; reason: "http-error"; status: number; agent: AgentConfig };

/**
 * Probe the agent's `/version` endpoint and classify the result.
 *
 * Never throws — every failure mode collapses into a typed `Reachability`
 * variant so callers can `switch` on `reason` without try/catch.
 */
export async function probeAgent(): Promise<Reachability> {
  const resolved = await getAgentBaseUrl();
  if (!resolved) return { ok: false, reason: "no-agent" };

  try {
    const res = await fetchWithTimeout(`${resolved.baseUrl}/version`, {
      timeout: REACHABILITY_TIMEOUT_MS,
      cache: "no-store",
    });

    if (!res.ok) {
      return {
        ok: false,
        reason: "http-error",
        status: res.status,
        agent: resolved.agent,
      };
    }

    const payload = (await res.json()) as {
      buildSha?: unknown;
      builtAt?: unknown;
      capabilities?: unknown;
    };

    // Defensive: malformed shape (missing fields, wrong types) → http-error.
    // We surface the actual HTTP status so callers can distinguish "agent
    // returned 200 with garbage" from "agent returned 500".
    if (
      typeof payload.buildSha !== "string" ||
      typeof payload.builtAt !== "string" ||
      !Array.isArray(payload.capabilities) ||
      !payload.capabilities.every((c): c is string => typeof c === "string")
    ) {
      return {
        ok: false,
        reason: "http-error",
        status: res.status,
        agent: resolved.agent,
      };
    }

    const build: AgentBuild = { sha: payload.buildSha, at: payload.builtAt };
    const capabilities: string[] = payload.capabilities;
    const missing = EXPECTED_CAPABILITIES.filter(
      (cap) => !capabilities.includes(cap),
    );

    if (missing.length > 0) {
      return {
        ok: false,
        reason: "stale-binary",
        build,
        missing: [...missing],
        agent: resolved.agent,
      };
    }

    return {
      ok: true,
      build,
      capabilities,
      agent: resolved.agent,
    };
  } catch {
    // fetchWithTimeout throws on timeout, network failure, or aborted signal.
    // We collapse all of these into "timeout" — the user-facing distinction
    // is "we couldn't talk to the agent", and the agent host:port is in scope
    // so banner copy can still be specific.
    return { ok: false, reason: "timeout", agent: resolved.agent };
  }
}
