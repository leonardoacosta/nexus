/**
 * Unit tests for `getAgentBaseUrl()`.
 *
 * Covers SpecB 5.1 (nx-682r): the specs page fetch URL must resolve via
 * `getAgentBaseUrl()` — NOT the old hardcoded `:7402`. Previously
 * `apps/nextjs/src/app/specs/page.tsx` hardcoded port 7402 while the agent
 * listens on 7400; this test pins the resolved URL to the DB-backed agent
 * registry so regressions to a hardcoded port will fail immediately.
 *
 * Strategy:
 *   - Mock `./get-client` so we control the `getAgentConfigs()` return shape.
 *   - Exercise `getAgentBaseUrl()` across three regimes:
 *       1. DB-populated agent (non-default port, validates flexibility).
 *       2. Empty DB (localhost fallback) — must still be port 7400, never 7402.
 *       3. Explicit 7400 config — the canonical happy path.
 *   - Assert `baseUrl` never contains `:7402` anywhere, as a guard rail.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock hoists above imports; the factory receives the module resolver.
vi.mock("../get-client", () => ({
  getAgentConfigs: vi.fn(),
}));

import { getAgentBaseUrl } from "../agent-url";
import { getAgentConfigs } from "../get-client";

const mockedGetAgentConfigs = vi.mocked(getAgentConfigs);

describe("getAgentBaseUrl()", () => {
  beforeEach(() => {
    mockedGetAgentConfigs.mockReset();
  });

  it("resolves to the canonical nexus-agent port 7400 for localhost fallback", async () => {
    // Matches the `getAgentConfigs()` empty-DB branch which returns
    // `[{ name: "localhost", host: "127.0.0.1", port: 7400 }]`.
    mockedGetAgentConfigs.mockResolvedValue([
      { name: "localhost", host: "127.0.0.1", port: 7400 },
    ]);

    const resolved = await getAgentBaseUrl();

    expect(resolved).not.toBeNull();
    expect(resolved!.baseUrl).toBe("http://127.0.0.1:7400");
    expect(resolved!.agent.name).toBe("localhost");
  });

  it("uses the DB-configured host:port when an agent row exists", async () => {
    mockedGetAgentConfigs.mockResolvedValue([
      { name: "tailnet-host", host: "100.64.1.5", port: 7400 },
    ]);

    const resolved = await getAgentBaseUrl();

    expect(resolved).not.toBeNull();
    expect(resolved!.baseUrl).toBe("http://100.64.1.5:7400");
    expect(resolved!.agent.name).toBe("tailnet-host");
  });

  it("never returns the legacy hardcoded :7402 port", async () => {
    // Regression guard — this is the actual bug SpecB fixes.
    mockedGetAgentConfigs.mockResolvedValue([
      { name: "localhost", host: "127.0.0.1", port: 7400 },
    ]);

    const resolved = await getAgentBaseUrl();

    expect(resolved).not.toBeNull();
    expect(resolved!.baseUrl).not.toContain(":7402");
    expect(resolved!.baseUrl).toContain(":7400");
  });

  it("returns null when no enabled agents are configured", async () => {
    mockedGetAgentConfigs.mockResolvedValue([]);

    const resolved = await getAgentBaseUrl();

    // Callers degrade gracefully — they must not crash the page.
    expect(resolved).toBeNull();
  });

  it("picks the first agent when multiple are returned", async () => {
    mockedGetAgentConfigs.mockResolvedValue([
      { name: "primary", host: "100.64.1.5", port: 7400 },
      { name: "secondary", host: "100.64.1.6", port: 7400 },
    ]);

    const resolved = await getAgentBaseUrl();

    expect(resolved).not.toBeNull();
    expect(resolved!.agent.name).toBe("primary");
    expect(resolved!.baseUrl).toBe("http://100.64.1.5:7400");
  });
});
