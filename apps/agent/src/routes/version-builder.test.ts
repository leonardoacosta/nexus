/**
 * Contract tests for buildVersionRoutes (task 2.7).
 *
 * Locks down the public shape of GET /version — the dashboard's handshake
 * probe. Any drift in capability ordering, dedup behaviour, payload keys,
 * or per-request work would silently break dashboards in the field.
 *
 * Run:
 *   cd apps/agent && bun run test src/routes/version-builder.test.ts
 */

import { describe, expect, test } from "bun:test";

import { buildVersionRoutes, type Route } from "./version-builder";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeRequest(): Request {
  return new Request("http://127.0.0.1:7400/version", { method: "GET" });
}

async function invoke(routes: Route[]): Promise<Response> {
  const route = routes[0]!;
  return Promise.resolve(route.handler(makeRequest(), {}));
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("buildVersionRoutes — route table", () => {
  test("returns a single GET /version route", () => {
    const routes = buildVersionRoutes([]);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.method).toBe("GET");
    expect(routes[0]!.path).toBe("/version");
  });
});

describe("buildVersionRoutes — response payload shape", () => {
  test("status 200, application/json, exact key set, value formats", async () => {
    const routes = buildVersionRoutes([
      { method: "GET", path: "/version", handler: () => new Response() },
      { method: "GET", path: "/health", handler: () => new Response() },
    ]);

    const res = await invoke(routes);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");

    const body = (await res.json()) as Record<string, unknown>;

    // Exact key set — no extras, no missing.
    expect(Object.keys(body).sort()).toEqual([
      "buildSha",
      "builtAt",
      "capabilities",
    ]);

    // buildSha: 7-40 lowercase hex chars.
    expect(typeof body.buildSha).toBe("string");
    expect(body.buildSha as string).toMatch(/^[0-9a-f]{7,40}$/);

    // builtAt: parseable ISO with explicit Z UTC suffix.
    expect(typeof body.builtAt).toBe("string");
    expect((body.builtAt as string).endsWith("Z")).toBe(true);
    expect(Number.isFinite(Date.parse(body.builtAt as string))).toBe(true);

    // capabilities: non-empty string array.
    expect(Array.isArray(body.capabilities)).toBe(true);
    expect((body.capabilities as string[]).length).toBeGreaterThan(0);
    for (const cap of body.capabilities as unknown[]) {
      expect(typeof cap).toBe("string");
    }
  });
});

describe("buildVersionRoutes — capabilities derivation", () => {
  test("alphabetically sorted and deduplicated", async () => {
    const routes = buildVersionRoutes([
      { method: "POST", path: "/b", handler: () => new Response() },
      { method: "GET", path: "/a", handler: () => new Response() },
      { method: "GET", path: "/a", handler: () => new Response() },
    ]);

    const res = await invoke(routes);
    const body = (await res.json()) as { capabilities: string[] };
    expect(body.capabilities).toEqual(["GET /a", "POST /b"]);
  });

  test("contains a newly added route", async () => {
    const routes = buildVersionRoutes([
      { method: "GET", path: "/foo/bar", handler: () => new Response() },
    ]);

    const res = await invoke(routes);
    const body = (await res.json()) as { capabilities: string[] };
    expect(body.capabilities).toContain("GET /foo/bar");
  });

  test("uppercases lowercase HTTP methods", async () => {
    const routes = buildVersionRoutes([
      // Lowercase method to prove the formatter normalises it.
      { method: "get" as unknown as Route["method"], path: "/a", handler: () => new Response() },
    ]);

    const res = await invoke(routes);
    const body = (await res.json()) as { capabilities: string[] };
    expect(body.capabilities).toContain("GET /a");
  });
});

describe("buildVersionRoutes — caching contract", () => {
  test("100 successive requests return byte-identical bodies", async () => {
    const routes = buildVersionRoutes([
      { method: "GET", path: "/version", handler: () => new Response() },
      { method: "GET", path: "/health", handler: () => new Response() },
      { method: "POST", path: "/sessions", handler: () => new Response() },
    ]);
    const route = routes[0]!;

    const bodies = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const res = await Promise.resolve(route.handler(makeRequest(), {}));
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });
});
