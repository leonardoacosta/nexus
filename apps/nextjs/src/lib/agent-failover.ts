/**
 * Transparent failover wrapper for per-agent fetches.
 *
 * `withFailover(fn)` runs `fn` against the currently-active agent (as
 * resolved by `probeAgents()`); if the call fails at the transport layer
 * — thrown errors from `fetchWithTimeout`, network reset, or any 5xx
 * response — it transparently retries against the next peer in DB order.
 * 4xx responses surface to the caller verbatim (a 403/404 is a semantic
 * answer, not a transport failure). On a successful peer retry the
 * agent-cache is invalidated so the next reachability check reprobes
 * from scratch and re-ranks the registry.
 *
 * Layering:
 *   - `agent-reachability.ts#probeAgents()` — picks the responder and
 *     surfaces the ordered tail of peers via the underlying registry probe.
 *   - `agent-url.ts#probeAgentRegistry({ startIndex })` — re-uses the
 *     already-walked registry to enumerate peers WITHOUT re-running
 *     capability checks against agents we already classified.
 *   - `agent-failover.ts` (this file) — call-time retry policy. Domain-
 *     specific fetchers wrap themselves with `withFailover` (tasks 2.5,
 *     2.6) to inherit failover for free.
 *
 * Spec: openspec/changes/dashboard-agent-failover/tasks.md [2.4]
 */

import type { AgentConfig } from "@nexus/core/node";
import * as agentCache from "@/lib/agent-cache";
import { probeAgents } from "@/lib/agent-reachability";
import { probeAgentRegistry } from "@/lib/agent-url";
import { getAgentConfigs } from "@/lib/get-client";

const CACHE_KEY = "active";

/**
 * Aggregated failure surfaced to callers when failover cannot complete.
 *
 *   reason: "no-responder"   → `probeAgents()` returned `ok: false` —
 *                              registry empty, every agent transport-failed,
 *                              or every responder was stale-binary. No
 *                              `fn(agent)` calls were attempted.
 *   reason: "all-peers-failed" → at least one `fn(agent)` was attempted
 *                              and all of them failed (thrown error or
 *                              5xx response).
 *
 * `attempted` lists every agent against which `fn` was invoked, in order.
 * For `no-responder` it is empty.
 */
export class AgentFailoverError extends Error {
  readonly attempted: AgentConfig[];
  readonly reason: "no-responder" | "all-peers-failed";

  constructor(
    reason: "no-responder" | "all-peers-failed",
    attempted: AgentConfig[],
    message: string,
  ) {
    super(message);
    this.name = "AgentFailoverError";
    this.reason = reason;
    this.attempted = attempted;
  }
}

/**
 * Locate the index of `agent` in the DB-ordered registry. `AgentConfig`
 * does not carry a stable opaque id at the public schema level (see
 * `packages/core/src/config.ts`), so we match on `name` first (the
 * canonical human-friendly identifier), falling back to host+port for
 * configs where `name` may have drifted. Returns -1 if not found —
 * callers fall back to "treat the responder as standalone with no peers".
 */
function indexOfAgent(agents: AgentConfig[], target: AgentConfig): number {
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!;
    if (a.name === target.name) return i;
    if (a.host === target.host && a.port === target.port) return i;
  }
  return -1;
}

/**
 * Decide whether a returned `Response` represents a transport-class
 * failure (retriable) versus a semantic answer (return verbatim).
 *
 * Status >= 500 → retriable (server error, try the next peer).
 * Status 4xx    → NOT retriable (the request was understood and refused
 *                 — retrying against another peer is unlikely to help and
 *                 hides bugs).
 * Status 2xx/3xx → not retriable (success).
 *
 * The runtime check is `instanceof Response`, so when the generic `T` is
 * not a `Response` (e.g. a parsed DTO) this returns false and the value
 * is returned to the caller.
 */
function isRetriableResponse(value: unknown): boolean {
  return value instanceof Response && value.status >= 500;
}

/**
 * Run `fn` against the active agent, transparently retrying against
 * subsequent peers on transport-class failure.
 *
 * Algorithm:
 *   1. Resolve the active agent via `probeAgents()`. On `ok: false`,
 *      throw `AgentFailoverError("no-responder", [], ...)`.
 *   2. Build the candidate list as `[responder, ...peers]` where `peers`
 *      is the ordered tail AFTER the responder in the DB registry. Agents
 *      BEFORE the responder were already walked (and either timed out or
 *      were classified stale) during the probe — re-trying them here
 *      would burn another timeout per agent.
 *   3. For each candidate, call `fn(agent)`:
 *        - thrown error                 → log and continue
 *        - returned `Response` 5xx     → log and continue
 *        - returned `Response` 4xx     → return verbatim (semantic failure)
 *        - any other returned value    → return verbatim (success)
 *   4. If a peer (not the original responder) succeeded, invalidate the
 *      `"active"` cache key so the next reachability check reprobes and
 *      re-ranks. We invalidate rather than `set()` because constructing a
 *      full `Reachability` for the new responder here would duplicate
 *      classifier logic; the next request will reprobe and find it
 *      anyway.
 *   5. If every candidate failed, throw
 *      `AgentFailoverError("all-peers-failed", attempted, ...)`.
 *
 * Logs are written via `console.warn` and prefixed with
 * `[agent-failover]`. This file runs server-side only (server actions /
 * route handlers); callers MUST NOT import it from client components.
 */
export async function withFailover<T>(
  fn: (agent: AgentConfig) => Promise<T>,
): Promise<T> {
  // 1. Resolve the active responder.
  const reach = await probeAgents();
  if (!reach.ok) {
    const reasonStr =
      reach.reason === "no-agent"
        ? "no agents in registry"
        : reach.reason === "all-failed"
          ? "all agents transport-failed"
          : "all responders stale-binary";
    throw new AgentFailoverError(
      "no-responder",
      [],
      `[agent-failover] no responder available (${reasonStr})`,
    );
  }

  // 2. Build the candidate list: responder + ordered tail.
  //
  // We re-call `probeAgentRegistry({ startIndex })` to get the peers list,
  // but only after locating the responder's index in the full ordered
  // registry. This avoids re-running per-agent /version probes against
  // already-classified agents — the registry probe with a startIndex AT
  // the responder will hit the responder first (already proven healthy)
  // and surface its peers. However, calling probeAgentRegistry here would
  // re-fetch /version from the responder; cheaper to slice
  // `getAgentConfigs()` directly.
  const allAgents = await getAgentConfigs();
  const responderIndex = indexOfAgent(allAgents, reach.agent);
  const candidates: AgentConfig[] =
    responderIndex >= 0
      ? allAgents.slice(responderIndex)
      : [reach.agent];

  // 3. Iterate candidates. Track every agent we actually invoke `fn`
  // against so the aggregated error is precise.
  const attempted: AgentConfig[] = [];
  const errors: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const agent = candidates[i]!;
    attempted.push(agent);

    try {
      const result = await fn(agent);

      // Runtime check: only meaningful when T extends Response. For
      // non-Response T (parsed DTOs, void, etc.) this is always false
      // and we return the value directly.
      if (isRetriableResponse(result)) {
        const status = (result as unknown as Response).status;
        errors.push(`${agent.name}: HTTP ${status}`);
        if (i < candidates.length - 1) {
          const next = candidates[i + 1]!;
          console.warn(
            `[agent-failover] ${agent.name} -> ${next.name} (HTTP ${status})`,
          );
        }
        continue;
      }

      // Success. If the responder we used was NOT the cached active
      // agent (i.e. we actually failed over), invalidate the cache so
      // the next reachability check reprobes and re-ranks.
      if (i > 0) {
        agentCache.invalidate(CACHE_KEY);
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${agent.name}: ${msg}`);
      if (i < candidates.length - 1) {
        const next = candidates[i + 1]!;
        console.warn(
          `[agent-failover] ${agent.name} -> ${next.name} (${msg})`,
        );
      }
      continue;
    }
  }

  // 5. Every candidate failed. Surface the full list to the caller.
  agentCache.invalidate(CACHE_KEY);
  throw new AgentFailoverError(
    "all-peers-failed",
    attempted,
    `[agent-failover] all peers failed: ${errors.join("; ")}`,
  );
}

/**
 * Re-export for callers that want to compose against `probeAgentRegistry`
 * directly (e.g. SSE proxy wiring in task 2.6). Not used by `withFailover`
 * itself — kept here so the failover module is the single import surface
 * for downstream domain fetchers.
 */
export { probeAgentRegistry };
