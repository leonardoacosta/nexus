/**
 * Unit tests for `probeAgent()` — the agent reachability classifier.
 *
 * Pins the 5 branches of the `Reachability` discriminated union so the
 * dashboard's diagnostic banner copy stays accurate. Misclassifying a
 * failure (e.g. timeout reported as http-error) shows the wrong banner
 * and misleads the user.
 *
 * Branches covered:
 *   1. { ok: true, build, capabilities, agent }
 *   2. { ok: false, reason: "no-agent" }
 *   3. { ok: false, reason: "timeout", agent }
 *   4. { ok: false, reason: "stale-binary", build, missing, agent }
 *   5. { ok: false, reason: "http-error", status, agent }
 *
 * Strategy:
 *   - vi.mock `@/lib/agent-url` to control `getAgentBaseUrl()` resolution.
 *   - vi.mock `@nexus/core/fetch` to control `fetchWithTimeout` outcomes.
 *   - Each `it()` exercises one branch + a couple of edge cases at the end.
 *
 * Spec: openspec/changes/agent-version-handshake/specs/dashboard-data-paths/spec.md
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.mock hoists above imports; factories return the mocked module shape.
vi.mock("@/lib/agent-url", () => ({
  getAgentBaseUrl: vi.fn(),
}));

vi.mock("@nexus/core/fetch", () => ({
  fetchWithTimeout: vi.fn(),
}));

import {
  probeAgent,
  EXPECTED_CAPABILITIES,
} from "../agent-reachability";
import { getAgentBaseUrl } from "@/lib/agent-url";
import { fetchWithTimeout } from "@nexus/core/fetch";

const mockedGetAgentBaseUrl = vi.mocked(getAgentBaseUrl);
const mockedFetchWithTimeout = vi.mocked(fetchWithTimeout);

const stubAgent = {
  name: "test-agent",
  host: "127.0.0.1",
  port: 7400,
  user: "test",
};

const stubResolution = {
  baseUrl: "http://127.0.0.1:7400",
  agent: stubAgent,
};

/**
 * Build a stand-in for the `Response` object returned by `fetchWithTimeout`.
 * Only the fields `probeAgent` actually reads are stubbed (`ok`, `status`,
 * `json()`); typed as `unknown as Response` to satisfy the signature without
 * implementing every Response method.
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

describe("probeAgent()", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ---- Branch 2: no-agent ---------------------------------------------------

  it('returns { ok: false, reason: "no-agent" } when no agent is registered', async () => {
    mockedGetAgentBaseUrl.mockResolvedValue(null);

    const result = await probeAgent();

    expect(result).toEqual({ ok: false, reason: "no-agent" });
    // Defensive: do not waste a 5s timeout when there's no agent to probe.
    expect(mockedFetchWithTimeout).not.toHaveBeenCalled();
  });

  // ---- Branch 3: timeout ----------------------------------------------------

  it('returns { ok: false, reason: "timeout", agent } when fetchWithTimeout throws', async () => {
    mockedGetAgentBaseUrl.mockResolvedValue(stubResolution);
    mockedFetchWithTimeout.mockRejectedValue(
      new Error("Request timed out after 5000ms"),
    );

    const result = await probeAgent();

    expect(result).toEqual({
      ok: false,
      reason: "timeout",
      agent: stubAgent,
    });
  });

  it('classifies generic network errors as "timeout" too', async () => {
    // The impl collapses ALL fetch failures into "timeout" — caller-facing
    // distinction is "we couldn't talk to the agent". Lock that behavior.
    mockedGetAgentBaseUrl.mockResolvedValue(stubResolution);
    mockedFetchWithTimeout.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await probeAgent();

    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });

  // ---- Branch 5: http-error (non-2xx) --------------------------------------

  it('returns { ok: false, reason: "http-error", status } on non-2xx response', async () => {
    mockedGetAgentBaseUrl.mockResolvedValue(stubResolution);
    mockedFetchWithTimeout.mockResolvedValue(
      fakeResponse({ ok: false, status: 500 }),
    );

    const result = await probeAgent();

    expect(result).toEqual({
      ok: false,
      reason: "http-error",
      status: 500,
      agent: stubAgent,
    });
  });

  it('preserves the actual HTTP status (e.g. 404) in the http-error variant', async () => {
    mockedGetAgentBaseUrl.mockResolvedValue(stubResolution);
    mockedFetchWithTimeout.mockResolvedValue(
      fakeResponse({ ok: false, status: 404 }),
    );

    const result = await probeAgent();

    expect(result).toMatchObject({ reason: "http-error", status: 404 });
  });

  // ---- Branch 5: http-error (malformed shape) ------------------------------

  it('returns { ok: false, reason: "http-error" } when the JSON shape is malformed', async () => {
    mockedGetAgentBaseUrl.mockResolvedValue(stubResolution);
    mockedFetchWithTimeout.mockResolvedValue(
      fakeResponse({
        ok: true,
        status: 200,
        json: () => ({ wrong: "shape" }),
      }),
    );

    const result = await probeAgent();

    // Surfaces 200 status — caller can distinguish "200 with garbage"
    // from "500 server error" via the status field.
    expect(result).toEqual({
      ok: false,
      reason: "http-error",
      status: 200,
      agent: stubAgent,
    });
  });

  it("treats non-string capabilities entries as malformed shape", async () => {
    mockedGetAgentBaseUrl.mockResolvedValue(stubResolution);
    mockedFetchWithTimeout.mockResolvedValue(
      fakeResponse({
        ok: true,
        status: 200,
        json: () => ({
          buildSha: "abc1234",
          builtAt: "2026-05-01T10:00:00Z",
          // Non-string element trips the `every((c): c is string)` guard.
          capabilities: ["GET /credentials", 42],
        }),
      }),
    );

    const result = await probeAgent();

    expect(result).toMatchObject({ ok: false, reason: "http-error" });
  });

  it("treats non-array capabilities as malformed shape", async () => {
    mockedGetAgentBaseUrl.mockResolvedValue(stubResolution);
    mockedFetchWithTimeout.mockResolvedValue(
      fakeResponse({
        ok: true,
        status: 200,
        json: () => ({
          buildSha: "abc1234",
          builtAt: "2026-05-01T10:00:00Z",
          capabilities: "GET /credentials",
        }),
      }),
    );

    const result = await probeAgent();

    expect(result).toMatchObject({ ok: false, reason: "http-error" });
  });

  // ---- Branch 4: stale-binary ----------------------------------------------

  it('returns { ok: false, reason: "stale-binary", missing } when capabilities are missing', async () => {
    mockedGetAgentBaseUrl.mockResolvedValue(stubResolution);
    mockedFetchWithTimeout.mockResolvedValue(
      fakeResponse({
        ok: true,
        status: 200,
        json: () => ({
          buildSha: "abc1234",
          builtAt: "2026-05-01T10:00:00Z",
          // Has GET /credentials but missing both /notifications/settings entries.
          capabilities: ["GET /credentials"],
        }),
      }),
    );

    const result = await probeAgent();

    expect(result).toEqual({
      ok: false,
      reason: "stale-binary",
      build: { sha: "abc1234", at: "2026-05-01T10:00:00Z" },
      missing: ["GET /notifications/settings", "PATCH /notifications/settings"],
      agent: stubAgent,
    });
  });

  it("reports only the absent capabilities in `missing` (no false positives)", async () => {
    // Has 2 of 3 expected capabilities; only the third should be in missing.
    mockedGetAgentBaseUrl.mockResolvedValue(stubResolution);
    mockedFetchWithTimeout.mockResolvedValue(
      fakeResponse({
        ok: true,
        status: 200,
        json: () => ({
          buildSha: "def5678",
          builtAt: "2026-05-02T11:00:00Z",
          capabilities: ["GET /credentials", "GET /notifications/settings"],
        }),
      }),
    );

    const result = await probeAgent();

    expect(result).toMatchObject({
      ok: false,
      reason: "stale-binary",
      missing: ["PATCH /notifications/settings"],
    });
    // Defensive: capabilities the agent DOES advertise must not appear as missing.
    if (result.ok === false && result.reason === "stale-binary") {
      expect(result.missing).not.toContain("GET /credentials");
      expect(result.missing).not.toContain("GET /notifications/settings");
    }
  });

  // ---- Branch 1: ok:true ----------------------------------------------------

  it("returns { ok: true } when all expected capabilities are present (with extras)", async () => {
    mockedGetAgentBaseUrl.mockResolvedValue(stubResolution);
    const advertised = [
      ...EXPECTED_CAPABILITIES,
      "GET /sessions",
      "POST /attach",
    ];
    mockedFetchWithTimeout.mockResolvedValue(
      fakeResponse({
        ok: true,
        status: 200,
        json: () => ({
          buildSha: "f00ba12",
          builtAt: "2026-05-03T12:00:00Z",
          capabilities: advertised,
        }),
      }),
    );

    const result = await probeAgent();

    expect(result).toEqual({
      ok: true,
      build: { sha: "f00ba12", at: "2026-05-03T12:00:00Z" },
      capabilities: advertised,
      agent: stubAgent,
    });
  });

  it("classifies as ok when capabilities exactly equal EXPECTED_CAPABILITIES", async () => {
    // Verbatim match — no extras, no missing. Should still be a clean ok:true.
    mockedGetAgentBaseUrl.mockResolvedValue(stubResolution);
    mockedFetchWithTimeout.mockResolvedValue(
      fakeResponse({
        ok: true,
        status: 200,
        json: () => ({
          buildSha: "exact01",
          builtAt: "2026-05-04T13:00:00Z",
          capabilities: [...EXPECTED_CAPABILITIES],
        }),
      }),
    );

    const result = await probeAgent();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.build).toEqual({
        sha: "exact01",
        at: "2026-05-04T13:00:00Z",
      });
      expect(result.capabilities).toEqual([...EXPECTED_CAPABILITIES]);
      expect(result.agent).toEqual(stubAgent);
    }
  });

  // ---- Probe URL contract --------------------------------------------------

  it("probes the agent's /version endpoint with a timeout and no-store cache", async () => {
    // Lock the wire-format contract so a future refactor doesn't accidentally
    // rename the path or drop cache: "no-store" (which would make banner
    // staleness sticky during a build cutover).
    mockedGetAgentBaseUrl.mockResolvedValue(stubResolution);
    mockedFetchWithTimeout.mockResolvedValue(
      fakeResponse({
        ok: true,
        status: 200,
        json: () => ({
          buildSha: "abc1234",
          builtAt: "2026-05-01T10:00:00Z",
          capabilities: [...EXPECTED_CAPABILITIES],
        }),
      }),
    );

    await probeAgent();

    expect(mockedFetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(mockedFetchWithTimeout).toHaveBeenCalledWith(
      "http://127.0.0.1:7400/version",
      expect.objectContaining({
        timeout: 5_000,
        cache: "no-store",
      }),
    );
  });
});
