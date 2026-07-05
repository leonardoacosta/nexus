/**
 * Unit tests for the VictoriaMetrics read client + per-session cost/token read
 * service + the repointed /sessions/{id}/tokens degraded path.
 *
 * Spec: openspec/changes/read-cc-telemetry-from-influxdb (cc-telemetry-read)
 *
 * Proves the degraded no-op contract (task 4.2): `VM_URL` unset ⇒ empty
 * breakdown ⇒ endpoint returns HTTP 200, agent stays healthy.
 */

import { describe, expect, it, afterEach, afterAll, mock } from "bun:test";
import type { Db } from "@nexus/db";
import * as fetchModule from "@nexus/core/fetch";
import { createVmReadClient, type VmReadClient, type VmSample } from "./vm-read";
import { readSessionCostTokens } from "./session-cost-read";
import { handleGetSessionTokens } from "../routes/sessions";

// Capture the REAL fetch before any module mock so we can restore it and never
// leak the stub into sibling test files (credential-usage-poller, vm-read).
const realFetchWithTimeout = fetchModule.fetchWithTimeout;

const savedVmUrl = process.env.VM_URL;
afterEach(() => {
  if (savedVmUrl === undefined) delete process.env.VM_URL;
  else process.env.VM_URL = savedVmUrl;
});

describe("createVmReadClient", () => {
  it("is disabled and returns [] when VM_URL is unset", async () => {
    delete process.env.VM_URL;
    const client = createVmReadClient();
    expect(client.enabled).toBe(false);
    expect(await client.query("up")).toEqual([]);
  });

  it("parses instant-vector samples from a VM success response", async () => {
    const body = {
      status: "success",
      data: {
        resultType: "vector",
        result: [
          { metric: { session_id: "s1", type: "input" }, value: [1700000000, "42"] },
        ],
      },
    };
    const client = createVmReadClient({
      url: "http://vm.test:8428",
      fetchImpl: (async () =>
        new Response(JSON.stringify(body), { status: 200 })) as never,
    });
    expect(client.enabled).toBe(true);
    const samples = await client.query("claude_code_token_usage_total");
    expect(samples).toEqual([{ metric: { session_id: "s1", type: "input" }, value: 42 }]);
  });

  it("degrades to [] on a transport error", async () => {
    const client = createVmReadClient({
      url: "http://vm.test:8428",
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as never,
    });
    expect(await client.query("up")).toEqual([]);
  });
});

/** Fake client that records queries and replays canned samples per metric. */
function fakeClient(
  samplesByMetric: Record<string, VmSample[]>,
  captured: string[] = [],
): VmReadClient {
  return {
    enabled: true,
    query: async (promql: string) => {
      captured.push(promql);
      const metric = promql.split("{")[0] ?? "";
      return samplesByMetric[metric] ?? [];
    },
  };
}

describe("readSessionCostTokens", () => {
  it("returns the empty breakdown (cost null) for a disabled client", async () => {
    const disabled: VmReadClient = { enabled: false, query: async () => [] };
    expect(await readSessionCostTokens(disabled, "s1")).toEqual({
      input: 0,
      output: 0,
      cache_creation: 0,
      cache_read: 0,
      cost_usd: null,
    });
  });

  it("sums cost and maps token types (cacheRead→cache_read etc)", async () => {
    const client = fakeClient({
      claude_code_cost_usage_USD_total: [
        { metric: { session_id: "s1" }, value: 0.12 },
        { metric: { session_id: "s1", model: "opus" }, value: 0.08 },
      ],
      claude_code_token_usage_total: [
        { metric: { type: "input" }, value: 100 },
        { metric: { type: "output" }, value: 50 },
        { metric: { type: "cacheRead" }, value: 10 },
        { metric: { type: "cacheCreation" }, value: 5 },
      ],
    });
    const out = await readSessionCostTokens(client, "s1");
    expect(out).toEqual({
      input: 100,
      output: 50,
      cache_creation: 5,
      cache_read: 10,
      cost_usd: 0.2,
    });
  });

  it("applies the session_id=~\".+\" reset-collision filter in every query", async () => {
    const captured: string[] = [];
    const client = fakeClient({}, captured);
    await readSessionCostTokens(client, "s1");
    expect(captured.length).toBe(2);
    for (const q of captured) {
      expect(q).toContain('session_id="s1"');
      expect(q).toContain('session_id=~".+"');
    }
  });

  // [4.4] Reset-collision regression: a cost series WITHOUT a session_id label
  // (the concurrent-session label-collision row cc's own dashboard had to
  // filter) MUST be excluded from the per-session total. The exclusion is
  // effected by the `session_id=~".+"` matcher, which VictoriaMetrics applies
  // server-side — so a series lacking the label never reaches the client. This
  // fake models VM's matcher behaviour: when the query carries `=~".+"`, drop
  // samples whose metric has no `session_id` label, then prove the label-less
  // collision value never lands in the sum.
  it("excludes a cost series lacking a session_id label from the total", async () => {
    const vmModelingClient: VmReadClient = {
      enabled: true,
      query: async (promql: string) => {
        const enforcesLabel = promql.includes('session_id=~".+"');
        // Raw upstream series: one correctly-labelled row + one label-collision
        // row (no session_id) that would inflate the total if not filtered.
        const raw: VmSample[] = promql.startsWith("claude_code_cost_usage_USD_total")
          ? [
              { metric: { session_id: "s1" }, value: 0.2 },
              { metric: {}, value: 99.0 }, // collision row — no session_id label
            ]
          : [];
        return enforcesLabel
          ? raw.filter((s) => s.metric.session_id !== undefined)
          : raw;
      },
    };

    const out = await readSessionCostTokens(vmModelingClient, "s1");
    // 99.0 collision series excluded by the =~".+" matcher; only 0.2 remains.
    expect(out.cost_usd).toBe(0.2);
  });
});

describe("GET /sessions/{id}/tokens — degraded path", () => {
  it("returns 200 with an empty breakdown when VM_URL is unset", async () => {
    delete process.env.VM_URL;
    // Minimal db stub: getSessionById → one row (select().from().where().limit()).
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ id: "s1" }]) }),
        }),
      }),
    } as unknown as Db;

    const res = await handleGetSessionTokens(db, "s1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      turns: unknown[];
      aggregates: Record<string, unknown>;
    };
    expect(json.turns).toEqual([]);
    expect(json.aggregates).toEqual({
      input: 0,
      output: 0,
      cache_creation: 0,
      cache_read: 0,
      cost_usd: null,
      turn_count: 0,
    });
  });

  it("returns 404 for an unknown session", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
    } as unknown as Db;
    const res = await handleGetSessionTokens(db, "missing");
    expect(res.status).toBe(404);
  });
});

// [4.1] Positive path: the endpoint sources cost + per-type tokens from
// VictoriaMetrics when the session has `claude_code_*` series present. The route
// constructs its own VM client internally (reads VM_URL + fetchWithTimeout), so
// we stub the wire: mock `@nexus/core/fetch` to return canned VM `/api/v1/query`
// responses keyed off the PromQL metric, and set VM_URL so the client enables.
describe("GET /sessions/{id}/tokens — VictoriaMetrics-sourced (4.1)", () => {
  afterAll(() => {
    // Restore the real fetch so no other test file sees the stub.
    mock.module("@nexus/core/fetch", () => ({
      ...fetchModule,
      fetchWithTimeout: realFetchWithTimeout,
    }));
  });

  it("returns cost + per-type tokens for a session with claude_code_* series", async () => {
    process.env.VM_URL = "http://vm.test:8428";

    mock.module("@nexus/core/fetch", () => ({
      ...fetchModule,
      fetchWithTimeout: async (url: string) => {
        const query = new URL(url).searchParams.get("query") ?? "";
        const result = query.startsWith("claude_code_cost_usage_USD_total")
          ? [{ metric: { session_id: "s1" }, value: [1700000000, "0.2"] }]
          : query.startsWith("claude_code_token_usage_total")
            ? [
                { metric: { session_id: "s1", type: "input" }, value: [1700000000, "100"] },
                { metric: { session_id: "s1", type: "output" }, value: [1700000000, "50"] },
                { metric: { session_id: "s1", type: "cacheRead" }, value: [1700000000, "10"] },
                { metric: { session_id: "s1", type: "cacheCreation" }, value: [1700000000, "5"] },
              ]
            : [];
        return new Response(
          JSON.stringify({ status: "success", data: { resultType: "vector", result } }),
          { status: 200 },
        );
      },
    }));

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ id: "s1" }]) }),
        }),
      }),
    } as unknown as Db;

    const res = await handleGetSessionTokens(db, "s1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      turns: unknown[];
      aggregates: Record<string, unknown>;
    };
    // VictoriaMetrics carries per-session totals, not per-turn rows.
    expect(json.turns).toEqual([]);
    expect(json.aggregates).toEqual({
      input: 100,
      output: 50,
      cache_creation: 5,
      cache_read: 10,
      cost_usd: 0.2,
      turn_count: 0,
    });
  });
});
