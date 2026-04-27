/**
 * Failover-aware agent reachability classifier.
 *
 * Walks the DB-ordered agent registry and returns the first responder
 * that satisfies `EXPECTED_CAPABILITIES`. Only returns failure when EVERY
 * agent in the registry fails (transport, HTTP, shape, OR stale binary).
 * Successful results are cached in `agent-cache.ts` with the default 60s
 * TTL so repeated `probeAgents()` calls inside a single render avoid the
 * registry walk.
 *
 * Layering:
 *   - `agent-url.ts#probeAgentRegistry()` — low-level registry walk; only
 *     verifies 2xx + well-formed `/version` shape.
 *   - `agent-reachability.ts#probeAgents()` (this file) — capability-aware
 *     wrapper. On a stale responder (missing capability) it resumes the
 *     walk via `probeAgentRegistry({ startIndex })` looking for a healthy
 *     peer.
 *
 * Spec: openspec/changes/dashboard-agent-failover/tasks.md [2.3]
 */

import type { AgentConfig } from "@nexus/core/node";
import * as agentCache from "@/lib/agent-cache";
import {
  probeAgentRegistry,
  type ProbeAttempt,
  type ProbeResult,
} from "@/lib/agent-url";

const CACHE_KEY = "active";

/**
 * Build identity reported by the agent. `sha` is the short git SHA the
 * agent was built from; `at` is an ISO-8601 build timestamp. Both come
 * straight from the agent's `/version` payload.
 */
export interface AgentBuild {
  sha: string;
  at: string;
}

/**
 * Capabilities the dashboard requires the agent to support.
 *
 * If the agent's /version response is missing any of these, the
 * reachability classifier flags that responder as `stale-binary` and
 * resumes the walk on the remaining peers. Only when EVERY responder is
 * stale does the classifier return `{ ok: false, reason: "stale-binary" }`.
 *
 * Add a new entry here when the dashboard starts depending on a new agent
 * endpoint. The underlying agent dispatcher must also serve it (see
 * LEGACY_DISPATCH_ROUTES in apps/agent/src/server-request-handler.ts).
 */
export const EXPECTED_CAPABILITIES: readonly string[] = [
  "GET /credentials",
  "GET /notifications/settings",
  "PATCH /notifications/settings",
] as const;

/**
 * Per-agent attempt captured for diagnostics. Mirrors `ProbeAttempt` from
 * `agent-url.ts` but adds the `stale-binary` outcome (a capability-layer
 * concern that the registry layer doesn't know about).
 *
 * Outcomes:
 *   ok            → 2xx + valid shape + every required capability present
 *   timeout       → AbortError, network failure, or per-agent timeout
 *   http-error    → reached the agent but it returned non-2xx (`status`)
 *   bad-shape     → 2xx but JSON missing fields or wrong types
 *   stale-binary  → 2xx + valid shape, but missing one or more
 *                   `EXPECTED_CAPABILITIES` (`missing` lists which)
 */
export type ReachabilityAttempt = { agent: AgentConfig } & (
  | { outcome: "ok" }
  | { outcome: "timeout" }
  | { outcome: "http-error"; status: number }
  | { outcome: "bad-shape" }
  | { outcome: "stale-binary"; missing: string[] }
);

/**
 * Discriminated union returned by `probeAgents()`.
 *
 *   ok: true             → at least one responder satisfied every required
 *                          capability. `agent` is that responder. `failover`
 *                          is true iff the responder was NOT the first
 *                          agent in DB order. `cached` is true iff the
 *                          result was served from `agent-cache` (the walk
 *                          was skipped). `attempts` is the ordered list of
 *                          per-agent attempts up to and including the
 *                          responder (cache hits return an empty
 *                          `attempts` list — see note below).
 *   reason: "no-agent"   → registry empty (theoretically impossible given
 *                          the localhost fallback in `getAgentConfigs()`,
 *                          defended anyway).
 *   reason: "all-failed" → walked the entire registry, every agent failed
 *                          at the transport / shape layer. `agent` is the
 *                          LAST agent attempted (terminal). `attempts`
 *                          carries one entry per agent for diagnostic
 *                          banner copy.
 *   reason: "stale-binary" → walked the entire registry, every responder
 *                          (those that DID return 2xx + valid shape) was
 *                          missing at least one required capability. `build`
 *                          and `missing` mirror the LAST stale responder.
 *                          `agent` is that last stale responder. `attempts`
 *                          carries the full walk including any
 *                          transport-failed agents.
 *
 * NOTE on cache hits — when the result is served from `agent-cache`, the
 * `attempts` list reflects the ORIGINAL walk that produced the cached
 * value. Callers reading `attempts.length` to count probes-this-render
 * should also check `cached` first.
 *
 * NOTE on legacy outcomes — the old `timeout` / `http-error` top-level
 * reasons are intentionally NOT in this union. They collapse into
 * `all-failed` with the rich `attempts[]` carrying per-agent details. The
 * notifications/credentials banner copy reads from the LAST attempt.
 */
export type Reachability =
  | {
      ok: true;
      build: AgentBuild;
      capabilities: string[];
      agent: AgentConfig;
      failover: boolean;
      cached?: boolean;
      attempts: ReachabilityAttempt[];
    }
  | { ok: false; reason: "no-agent" }
  | {
      ok: false;
      reason: "all-failed";
      attempts: ReachabilityAttempt[];
      agent: AgentConfig;
    }
  | {
      ok: false;
      reason: "stale-binary";
      build: AgentBuild;
      missing: string[];
      agent: AgentConfig;
      attempts: ReachabilityAttempt[];
    };

/**
 * Convert a registry-layer `ProbeAttempt` to a capability-layer
 * `ReachabilityAttempt`. The `payload` field on `outcome: "ok"` is dropped
 * here — capability validation is the caller's job.
 */
function toReachabilityAttempt(p: ProbeAttempt): ReachabilityAttempt {
  switch (p.outcome) {
    case "ok":
      return { agent: p.agent, outcome: "ok" };
    case "timeout":
      return { agent: p.agent, outcome: "timeout" };
    case "http-error":
      return { agent: p.agent, outcome: "http-error", status: p.status };
    case "bad-shape":
      return { agent: p.agent, outcome: "bad-shape" };
  }
}

/**
 * Compute which `EXPECTED_CAPABILITIES` are missing from the responder's
 * `/version` payload. Empty array means the responder is healthy.
 */
function missingCapabilities(reported: readonly string[]): string[] {
  return EXPECTED_CAPABILITIES.filter((cap) => !reported.includes(cap));
}

/**
 * Probe the agent registry and classify the result, with capability-aware
 * failover.
 *
 * Algorithm:
 *   1. Cache hit on `"active"` — return the cached `Reachability` with
 *      `cached: true`.
 *   2. Call `probeAgentRegistry()`. On `no-agent` return verbatim. On
 *      `all-failed` convert attempts and return with the LAST agent.
 *   3. On `ok: true` from the registry — run the capability check on the
 *      responder's payload. If healthy, build the success result, cache
 *      it, and return.
 *   4. If the responder is stale (missing a required capability), record
 *      it as a `stale-binary` attempt and resume the walk on
 *      `responderIndex + 1` via `probeAgentRegistry({ startIndex })`.
 *      Repeat until either a healthy responder is found or the registry
 *      is exhausted.
 *   5. If the entire registry is exhausted with all responders stale,
 *      return `{ ok: false, reason: "stale-binary", ... }` from the LAST
 *      stale responder. Don't cache failures.
 *
 * Never throws — every failure mode collapses into a typed `Reachability`
 * variant so callers can `switch` on `reason` without try/catch.
 */
export async function probeAgents(): Promise<Reachability> {
  // 1. Cache fast-path.
  const cached = agentCache.get(CACHE_KEY);
  if (cached && cached.ok) {
    return { ...cached, cached: true };
  }

  // Aggregate every reachability attempt from EVERY registry pass so
  // callers see the full picture (including stale responders we walked
  // past). `lastStaleResponder` tracks the most-recent stale responder
  // for the terminal `stale-binary` failure shape.
  const allAttempts: ReachabilityAttempt[] = [];
  let lastStaleResponder:
    | {
        agent: AgentConfig;
        build: AgentBuild;
        missing: string[];
      }
    | null = null;

  // 2/3/4. Iteratively probe the registry, advancing past stale
  // responders. Bounded by registry length (each pass starts strictly
  // after the previous responder), so termination is guaranteed.
  let startIndex = 0;
  while (true) {
    const probe: ProbeResult = await probeAgentRegistry({ startIndex });

    if (!probe.ok && probe.reason === "no-agent") {
      // 2a. Registry exhausted (or empty on the first pass).
      if (lastStaleResponder) {
        // Every responder we found was stale.
        return {
          ok: false,
          reason: "stale-binary",
          build: lastStaleResponder.build,
          missing: lastStaleResponder.missing,
          agent: lastStaleResponder.agent,
          attempts: allAttempts,
        };
      }
      // First-pass empty registry. No agents were ever attempted.
      if (allAttempts.length === 0) {
        return { ok: false, reason: "no-agent" };
      }
      // Should not happen — if we got here we had a previous pass with
      // attempts but no stale responder, which means the previous pass
      // returned `all-failed` and we'd have exited there. Defended for
      // total-function-ness:
      return {
        ok: false,
        reason: "all-failed",
        attempts: allAttempts,
        agent: allAttempts[allAttempts.length - 1]!.agent,
      };
    }

    if (!probe.ok && probe.reason === "all-failed") {
      // 2b. Every remaining agent failed at the transport / shape layer.
      const converted = probe.attempts.map(toReachabilityAttempt);
      allAttempts.push(...converted);

      if (lastStaleResponder) {
        // We found stale responders earlier in the walk — the terminal
        // story is "stale-binary across the registry" rather than
        // "all-failed". The trailing transport failures are still
        // captured in `attempts` for diagnostics.
        return {
          ok: false,
          reason: "stale-binary",
          build: lastStaleResponder.build,
          missing: lastStaleResponder.missing,
          agent: lastStaleResponder.agent,
          attempts: allAttempts,
        };
      }

      const lastAttempt = allAttempts[allAttempts.length - 1];
      if (!lastAttempt) {
        // Registry was empty on the very first pass — fall through to
        // no-agent rather than fabricating an `agent` field.
        return { ok: false, reason: "no-agent" };
      }
      return {
        ok: false,
        reason: "all-failed",
        attempts: allAttempts,
        agent: lastAttempt.agent,
      };
    }

    if (!probe.ok) {
      // Exhaustiveness guard — `ProbeResult` failures are no-agent or
      // all-failed; the type system should make this branch unreachable.
      // Kept as a defensive escape hatch.
      return { ok: false, reason: "no-agent" };
    }

    // 3. Registry returned a responder. Run the capability check.
    const responderAgent = probe.active.agent;
    const responderIndex = probe.firstResponderIndex;
    const payload = probe.payload;
    const build: AgentBuild = {
      sha: payload.buildSha,
      at: payload.builtAt,
    };
    const reportedCapabilities = payload.capabilities;
    const missing = missingCapabilities(reportedCapabilities);

    // Convert every attempt EXCEPT the last (the responder); we need to
    // override that one with either `ok` or `stale-binary`.
    const headAttempts = probe.attempts
      .slice(0, -1)
      .map(toReachabilityAttempt);
    allAttempts.push(...headAttempts);

    if (missing.length === 0) {
      // 3a. Healthy responder. Record `ok` attempt, build success,
      // cache, return.
      allAttempts.push({ agent: responderAgent, outcome: "ok" });
      const result: Reachability = {
        ok: true,
        build,
        capabilities: reportedCapabilities,
        agent: responderAgent,
        failover: responderIndex > 0,
        attempts: allAttempts,
      };
      agentCache.set(CACHE_KEY, result);
      return result;
    }

    // 4. Stale responder. Record the stale-binary attempt, remember it
    // for the terminal failure shape, and resume past it.
    allAttempts.push({
      agent: responderAgent,
      outcome: "stale-binary",
      missing: [...missing],
    });
    lastStaleResponder = {
      agent: responderAgent,
      build,
      missing: [...missing],
    };
    startIndex = responderIndex + 1;
  }
}

/**
 * Probe the agent registry and classify the result.
 *
 * @deprecated Use `probeAgents()`. This alias preserves the pre-failover
 * call signature for any unmigrated callers; the return type widens to
 * include the new failover-aware variants.
 */
export async function probeAgent(): Promise<Reachability> {
  return probeAgents();
}
