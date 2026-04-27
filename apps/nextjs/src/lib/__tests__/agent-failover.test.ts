/**
 * Unit tests for `withFailover<T>(fn)` and the `agent-cache` TTL behavior.
 *
 * The two modules are co-tested because `withFailover` consumes
 * `probeAgents()` (which consults `agent-cache` first), so the cache
 * semantics directly drive the failover behavior. Splitting them would
 * require duplicating mock setup.
 *
 * Strategy:
 *   - The REAL `agent-cache` module is exercised end-to-end (no mock). Tests
 *     reach in via the public `get`/`set`/`invalidate`/`clear` exports.
 *   - `@/lib/get-client` is mocked to provide a deterministic two-agent
 *     registry: [macbook, homelab].
 *   - `@nexus/core/fetch` is mocked so we can deterministically drive
 *     `probeAgents()` (which internally calls `fetchWithTimeout` for
 *     `/version`) without real network I/O.
 *   - For TTL expiry we use `vi.useFakeTimers()` because `agent-cache.nowFn`
 *     is module-private. Fake timers transparently mock `Date.now()`.
 *
 * Spec: openspec/changes/dashboard-agent-failover/tasks.md [2.8]
 */

import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import type { AgentConfig } from "@nexus/core/node";

// vi.mock hoists above imports.
vi.mock("@/lib/get-client", () => ({
  getAgentConfigs: vi.fn(),
}));

vi.mock("@nexus/core/fetch", () => ({
  fetchWithTimeout: vi.fn(),
}));

import * as agentCache from "../agent-cache";
import { probeAgents, EXPECTED_CAPABILITIES, type Reachability } from "../agent-reachability";
import { withFailover, AgentFailoverError } from "../agent-failover";
import { getAgentConfigs } from "@/lib/get-client";
import { fetchWithTimeout } from "@nexus/core/fetch";

const mockedGetAgentConfigs = vi.mocked(getAgentConfigs);
const mockedFetchWithTimeout = vi.mocked(fetchWithTimeout);

// --- Fixtures ----------------------------------------------------------------

const macbook: AgentConfig = {
  name: "macbook",
  host: "100.64.1.5",
  port: 7400,
};

const homelab: AgentConfig = {
  name: "homelab",
  host: "100.64.1.6",
  port: 7400,
};

/**
 * Construct a minimal valid `Reachability { ok: true, ... }` for use in
 * `agentCache.set("active", ...)` pre-population.
 */
function fakeOkReachability(agent: AgentConfig): Reachability {
  return {
    ok: true,
    build: { sha: "abc1234", at: "2026-04-27T10:00:00Z" },
    capabilities: [...EXPECTED_CAPABILITIES],
    agent,
    failover: false,
    attempts: [{ agent, outcome: "ok" }],
  };
}

/**
 * Build a stand-in `Response` with only the fields the production code reads
 * (`ok`, `status`, `json()`).
 */
function fakeResponse(opts: {
  ok: boolean;
  status: number;
  json?: () => unknown;
}): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    json: async () => (opts.json ? opts.json() : {}),
  } as unknown as Response;
}

// -----------------------------------------------------------------------------

describe("agent-cache", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    agentCache.clear();
    mockedGetAgentConfigs.mockReset();
    mockedFetchWithTimeout.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  // ---- Case 1: cache hit skips network --------------------------------------

  it("cache hit skips the registry walk (no fetch issued)", async () => {
    mockedGetAgentConfigs.mockResolvedValue([macbook, homelab]);

    // Pre-populate the cache with a healthy responder.
    agentCache.set("active", fakeOkReachability(macbook));

    const result = await probeAgents();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cached).toBe(true);
      expect(result.agent).toEqual(macbook);
    }
    // Critical: cache hits MUST NOT touch the network.
    expect(mockedFetchWithTimeout).not.toHaveBeenCalled();
  });

  // ---- Case 2: cache miss after TTL reprobes --------------------------------

  it("re-probes the registry after the TTL has elapsed", async () => {
    vi.useFakeTimers();
    // Anchor wall clock so `Date.now()` is deterministic.
    vi.setSystemTime(new Date("2026-04-27T10:00:00Z"));

    mockedGetAgentConfigs.mockResolvedValue([macbook, homelab]);
    // First responder during reprobe.
    mockedFetchWithTimeout.mockResolvedValue(
      fakeResponse({
        ok: true,
        status: 200,
        json: () => ({
          buildSha: "abc1234",
          builtAt: "2026-04-27T10:00:00Z",
          capabilities: [...EXPECTED_CAPABILITIES],
        }),
      }),
    );

    // Cache the macbook with a 100ms TTL.
    agentCache.set("active", fakeOkReachability(macbook), 100);

    // Sanity: still in cache before TTL elapses.
    expect(agentCache.get("active")).not.toBeNull();

    // Advance past the TTL.
    vi.advanceTimersByTime(200);

    // Cache should have lazily expired.
    expect(agentCache.get("active")).toBeNull();

    // Probing again now MUST hit the network (cache empty).
    const result = await probeAgents();

    expect(mockedFetchWithTimeout).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  // ---- Case 3: failure result is NOT cached ---------------------------------

  it("does NOT cache failure results (every agent transport-failed)", async () => {
    mockedGetAgentConfigs.mockResolvedValue([macbook, homelab]);
    // Both agents reject — the entire registry transport-fails.
    mockedFetchWithTimeout.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await probeAgents();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("all-failed");
    }

    // Critical invariant: a failed probe must NOT pollute the cache —
    // otherwise the dashboard would be pinned to a dead agent for the
    // TTL window even after the agent recovers.
    expect(agentCache.get("active")).toBeNull();
  });
});

// -----------------------------------------------------------------------------

describe("withFailover", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    agentCache.clear();
    mockedGetAgentConfigs.mockReset();
    mockedFetchWithTimeout.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  // ---- Case 4: cached agent succeeds — single call, no failover -------------

  it("calls fn once against the cached agent on success and emits no warn log", async () => {
    mockedGetAgentConfigs.mockResolvedValue([macbook, homelab]);
    agentCache.set("active", fakeOkReachability(macbook));

    const fn: Mock<(agent: AgentConfig) => Promise<string>> = vi
      .fn()
      .mockResolvedValue("first-response");

    const result = await withFailover(fn);

    expect(result).toBe("first-response");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(macbook);
    // No failover happened → no `[agent-failover]` log line.
    expect(warnSpy).not.toHaveBeenCalled();
    // Cache untouched on the happy path.
    expect(agentCache.get("active")).not.toBeNull();
  });

  // ---- Case 5: cached agent network-fails, peer succeeds, cache invalidated -

  it("retries on thrown error, succeeds on peer, invalidates cache, emits warn", async () => {
    mockedGetAgentConfigs.mockResolvedValue([macbook, homelab]);
    agentCache.set("active", fakeOkReachability(macbook));

    const fn: Mock<(agent: AgentConfig) => Promise<string>> = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce("peer-response");

    const result = await withFailover(fn);

    expect(result).toBe("peer-response");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, macbook);
    expect(fn).toHaveBeenNthCalledWith(2, homelab);

    // Warn log must mention the failover transition with the prefix.
    expect(warnSpy).toHaveBeenCalled();
    const allWarnArgs = warnSpy.mock.calls.flat().join(" ");
    expect(allWarnArgs).toContain("[agent-failover]");
    expect(allWarnArgs).toContain("macbook");
    expect(allWarnArgs).toContain("homelab");

    // Cache invalidated so the next reachability check reprobes/re-ranks.
    expect(agentCache.get("active")).toBeNull();
  });

  // ---- Case 6: cached agent returns 5xx — peer succeeds ---------------------

  it("retries on 5xx Response, returns the peer Response, emits warn", async () => {
    mockedGetAgentConfigs.mockResolvedValue([macbook, homelab]);
    agentCache.set("active", fakeOkReachability(macbook));

    // `withFailover` uses `value instanceof Response` to classify retriable
    // responses, so we MUST use the real `Response` constructor here. A duck-
    // typed stand-in fails the instanceof check and is returned verbatim.
    const errResponse = new Response(null, { status: 503 });
    const okResponse = new Response(null, { status: 200 });

    const fn: Mock<(agent: AgentConfig) => Promise<Response>> = vi
      .fn()
      .mockResolvedValueOnce(errResponse)
      .mockResolvedValueOnce(okResponse);

    const result = await withFailover(fn);

    expect(result).toBe(okResponse);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, macbook);
    expect(fn).toHaveBeenNthCalledWith(2, homelab);

    expect(warnSpy).toHaveBeenCalled();
    const allWarnArgs = warnSpy.mock.calls.flat().join(" ");
    expect(allWarnArgs).toContain("[agent-failover]");
    expect(allWarnArgs).toContain("503");

    // Successful peer means cache must be invalidated for re-ranking.
    expect(agentCache.get("active")).toBeNull();
  });

  // ---- Case 7: cached agent returns 4xx — NOT a failover trigger ------------

  it("returns 4xx Response directly without failover (semantic refusal, not transport)", async () => {
    mockedGetAgentConfigs.mockResolvedValue([macbook, homelab]);
    agentCache.set("active", fakeOkReachability(macbook));

    // Real Response instance — locks in that 4xx is not retriable even when
    // `instanceof Response` is true (i.e. exercises the status guard, not
    // the instanceof guard).
    const badRequest = new Response(null, { status: 400 });
    const fn: Mock<(agent: AgentConfig) => Promise<Response>> = vi
      .fn()
      .mockResolvedValueOnce(badRequest);

    const result = await withFailover(fn);

    // Verbatim return — caller decides how to interpret a 400.
    expect(result).toBe(badRequest);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(macbook);

    // No `[agent-failover]` warn lines on a non-retriable response.
    expect(warnSpy).not.toHaveBeenCalled();

    // Cache must remain populated — a 4xx is a semantic answer, the agent
    // is healthy and should keep its slot.
    expect(agentCache.get("active")).not.toBeNull();
  });

  // ---- Case 8: all peers fail — throws AgentFailoverError, cache cleared ----

  it("throws AgentFailoverError naming all attempted agents when every peer fails", async () => {
    mockedGetAgentConfigs.mockResolvedValue([macbook, homelab]);
    agentCache.set("active", fakeOkReachability(macbook));

    const fn: Mock<(agent: AgentConfig) => Promise<string>> = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(withFailover(fn)).rejects.toThrow(AgentFailoverError);

    // Re-run to capture the thrown error's properties (the rejection above
    // discards the instance). vi.fn keeps the mock state; reset call count
    // by reissuing the same rejection.
    fn.mockClear();
    fn.mockRejectedValue(new Error("ECONNREFUSED"));
    agentCache.set("active", fakeOkReachability(macbook));

    let caught: unknown;
    try {
      await withFailover(fn);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AgentFailoverError);
    const fail = caught as AgentFailoverError;
    expect(fail.reason).toBe("all-peers-failed");

    // Both agents must appear in `attempted` in DB order.
    expect(fail.attempted).toHaveLength(2);
    expect(fail.attempted[0]).toEqual(macbook);
    expect(fail.attempted[1]).toEqual(homelab);

    // Both names must be present in the message.
    expect(fail.message).toContain("macbook");
    expect(fail.message).toContain("homelab");

    // Cache MUST be cleared on terminal failure so the next request reprobes.
    expect(agentCache.get("active")).toBeNull();

    // Both peers should have been called.
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
