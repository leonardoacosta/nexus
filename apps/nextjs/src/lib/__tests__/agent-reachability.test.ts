/**
 * Unit tests for `probeAgents()` — the failover-aware reachability classifier.
 *
 * Pins the variants of the new `Reachability` discriminated union introduced
 * by `dashboard-agent-failover` (tasks 2.1–2.3). The classifier walks the
 * DB-ordered agent registry and only returns failure when EVERY agent fails;
 * misclassifying any branch (e.g. reporting an `all-failed` walk as
 * `no-agent`, or reporting a stale-binary fall-through as a top-level
 * `stale-binary` when a healthy peer exists) breaks the dashboard banner.
 *
 * Variants under test:
 *   1. { ok: true, build, capabilities, agent, failover, cached?, attempts }
 *   2. { ok: false, reason: "no-agent" }                  (empty registry)
 *   3. { ok: false, reason: "all-failed", attempts, agent }
 *   4. { ok: false, reason: "stale-binary", build, missing, agent, attempts }
 *
 * Strategy:
 *   - vi.mock `@/lib/get-client` so we control `getAgentConfigs()` per-test.
 *     `probeAgents()` reaches `getAgentConfigs()` indirectly through
 *     `probeAgentRegistry()` in `agent-url.ts`.
 *   - vi.mock `@nexus/core/fetch` so we control per-agent `/version` results.
 *     `mockResolvedValueOnce` stages call-by-call responses for the walk.
 *   - `agentCache.clear()` before every test so cache state doesn't leak.
 *
 * Spec: openspec/changes/dashboard-agent-failover/tasks.md [2.7]
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.mock hoists above the imports below; factory returns the mocked module
// shape used by both `agent-reachability.ts` and its dependency
// `agent-url.ts` (which is the actual caller of `getAgentConfigs`).
vi.mock("@/lib/get-client", () => ({
  getAgentConfigs: vi.fn(),
}));

vi.mock("@nexus/core/fetch", () => ({
  fetchWithTimeout: vi.fn(),
}));

import { probeAgents, EXPECTED_CAPABILITIES } from "../agent-reachability";
import * as agentCache from "../agent-cache";
import { getAgentConfigs } from "@/lib/get-client";
import { fetchWithTimeout } from "@nexus/core/fetch";

const mockedGetAgentConfigs = vi.mocked(getAgentConfigs);
const mockedFetchWithTimeout = vi.mocked(fetchWithTimeout);

const agentA = {
  name: "primary",
  host: "100.64.1.5",
  port: 7400,
};

const agentB = {
  name: "secondary",
  host: "100.64.1.6",
  port: 7400,
};

/**
 * Build a stand-in for the `Response` object returned by `fetchWithTimeout`.
 * Only the fields read by `probeAgentRegistry()` are stubbed (`ok`,
 * `status`, `json()`); typed as `unknown as Response` to satisfy the
 * signature without implementing the full `Response` surface.
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

/**
 * Convenience builder for a healthy `/version` response carrying every
 * `EXPECTED_CAPABILITIES` entry plus optional extras.
 */
function healthyVersionResponse(opts: {
  sha: string;
  at: string;
  extras?: string[];
}): Response {
  return fakeResponse({
    ok: true,
    status: 200,
    json: () => ({
      buildSha: opts.sha,
      builtAt: opts.at,
      capabilities: [...EXPECTED_CAPABILITIES, ...(opts.extras ?? [])],
    }),
  });
}

describe("probeAgents()", () => {
  beforeEach(() => {
    // Clear the module-scoped cache so a previous test's `ok` result
    // doesn't short-circuit the next test's registry walk.
    agentCache.clear();
    vi.resetAllMocks();
  });

  // ---- Mandatory case 1: first agent up, no failover ----------------------

  it("returns ok with failover=false and does not probe the second agent when the first is healthy", async () => {
    mockedGetAgentConfigs.mockResolvedValue([agentA, agentB]);
    // Stage exactly one response — the second agent must never be probed.
    mockedFetchWithTimeout.mockResolvedValueOnce(
      healthyVersionResponse({
        sha: "aaa1111",
        at: "2026-05-01T10:00:00Z",
        extras: ["GET /sessions"],
      }),
    );

    const result = await probeAgents();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.failover).toBe(false);
    expect(result.agent.name).toBe(agentA.name);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      agent: { name: agentA.name },
      outcome: "ok",
    });
    expect(result.build).toEqual({
      sha: "aaa1111",
      at: "2026-05-01T10:00:00Z",
    });
    // Pin the no-extra-probe contract — the second agent's `/version` must
    // not be hit when the first responds healthily.
    expect(mockedFetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(mockedFetchWithTimeout).toHaveBeenCalledWith(
      "http://100.64.1.5:7400/version",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  // ---- Mandatory case 2: first down, second up — failover=true ------------

  it("returns ok with failover=true when the first agent times out and the second is healthy", async () => {
    mockedGetAgentConfigs.mockResolvedValue([agentA, agentB]);
    // First call rejects (the registry walk collapses any thrown error
    // from `fetchWithTimeout` into outcome="timeout"); second succeeds.
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    mockedFetchWithTimeout.mockRejectedValueOnce(abortError);
    mockedFetchWithTimeout.mockResolvedValueOnce(
      healthyVersionResponse({
        sha: "bbb2222",
        at: "2026-05-02T11:00:00Z",
      }),
    );

    const result = await probeAgents();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.failover).toBe(true);
    expect(result.agent.name).toBe(agentB.name);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({
      agent: { name: agentA.name },
      outcome: "timeout",
    });
    expect(result.attempts[1]).toMatchObject({
      agent: { name: agentB.name },
      outcome: "ok",
    });
    expect(mockedFetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  // ---- Mandatory case 3: all agents down ----------------------------------

  it('returns reason "all-failed" with attempts when every agent fails at the transport layer', async () => {
    mockedGetAgentConfigs.mockResolvedValue([agentA, agentB]);
    mockedFetchWithTimeout.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    mockedFetchWithTimeout.mockResolvedValueOnce(
      fakeResponse({ ok: false, status: 503 }),
    );

    const result = await probeAgents();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("all-failed");
    if (result.reason !== "all-failed") return;
    expect(result.attempts).toHaveLength(2);
    // The terminal `agent` is the LAST attempted, not the first — pin
    // this so the banner copy can name the right host.
    expect(result.agent.name).toBe(agentB.name);
    // First attempt: thrown error → "timeout".
    expect(result.attempts[0]).toMatchObject({
      agent: { name: agentA.name },
      outcome: "timeout",
    });
    // Second attempt: 503 → "http-error" with status surfaced for diagnostics.
    expect(result.attempts[1]).toMatchObject({
      agent: { name: agentB.name },
      outcome: "http-error",
      status: 503,
    });
    // Defensive: an http-error attempt with status 503 must appear somewhere.
    expect(
      result.attempts.some(
        (a) => a.outcome === "http-error" && a.status === 503,
      ),
    ).toBe(true);
  });

  // ---- Mandatory case 4: stale binary on first, healthy second ------------

  it("falls through a stale first responder to a healthy second agent (failover=true)", async () => {
    mockedGetAgentConfigs.mockResolvedValue([agentA, agentB]);
    // First responds 200 but is missing GET /credentials — this is the
    // capability-layer concern that must not surface as a top-level
    // stale-binary failure when a healthy peer exists.
    mockedFetchWithTimeout.mockResolvedValueOnce(
      fakeResponse({
        ok: true,
        status: 200,
        json: () => ({
          buildSha: "stale01",
          builtAt: "2026-05-03T12:00:00Z",
          capabilities: [
            "GET /notifications/settings",
            "PATCH /notifications/settings",
          ],
        }),
      }),
    );
    mockedFetchWithTimeout.mockResolvedValueOnce(
      healthyVersionResponse({
        sha: "ccc3333",
        at: "2026-05-04T13:00:00Z",
      }),
    );

    const result = await probeAgents();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.failover).toBe(true);
    expect(result.agent.name).toBe(agentB.name);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({
      agent: { name: agentA.name },
      outcome: "stale-binary",
    });
    // Type-narrow before reading `missing` — the discriminated-union
    // payload only carries it on the stale-binary branch.
    const firstAttempt = result.attempts[0]!;
    if (firstAttempt.outcome !== "stale-binary") {
      throw new Error("expected stale-binary outcome on first attempt");
    }
    expect(firstAttempt.missing).toContain("GET /credentials");
    expect(result.attempts[1]).toMatchObject({
      agent: { name: agentB.name },
      outcome: "ok",
    });
  });

  // ---- Supporting case 5: cache hit ---------------------------------------

  it("serves the second call from cache (cached=true) and skips the network", async () => {
    mockedGetAgentConfigs.mockResolvedValue([agentA, agentB]);
    mockedFetchWithTimeout.mockResolvedValueOnce(
      healthyVersionResponse({
        sha: "ddd4444",
        at: "2026-05-05T14:00:00Z",
      }),
    );

    const first = await probeAgents();
    expect(first.ok).toBe(true);
    expect(mockedFetchWithTimeout).toHaveBeenCalledTimes(1);

    // Reset just the call count — the cache itself is intentionally NOT
    // cleared. A second probeAgents() within the TTL window should be
    // served from cache without touching the network.
    mockedFetchWithTimeout.mockClear();

    const second = await probeAgents();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.cached).toBe(true);
    expect(second.agent.name).toBe(agentA.name);
    expect(mockedFetchWithTimeout).not.toHaveBeenCalled();
  });

  // ---- Supporting case 6: empty registry → no-agent (no HTTP) -------------

  it('returns reason "no-agent" without HTTP calls when the registry is empty', async () => {
    // Note: production `getAgentConfigs()` falls back to localhost when
    // the table is empty, so this case requires fully mocking the
    // function to return an empty array.
    mockedGetAgentConfigs.mockResolvedValue([]);

    const result = await probeAgents();

    expect(result).toEqual({ ok: false, reason: "no-agent" });
    expect(mockedFetchWithTimeout).not.toHaveBeenCalled();
  });
});
