/**
 * Credential TLS enforcement tests (unit — no PG).
 *
 * Tests TLS enforcement for credential routes: non-loopback HTTP rejection,
 * loopback HTTP allowance, and HTTPS passthrough.
 */

import { describe, expect, it, afterEach } from "bun:test";
import { TEST_KEY } from "./credentials.helpers";

// ─── TLS enforcement (unit — no PG) ──────────────────────────────────────────

describe("credential routes — TLS enforcement (unit)", () => {
  // [6.2 / 12.7] TLS enforcement: non-loopback HTTP → 426; loopback HTTP and HTTPS pass
  it("[12.7] non-loopback HTTP request is rejected with 426 Upgrade Required", async () => {
    const { handleAddCredential, initCredentialRoutes } = await import("../routes/credentials");

    initCredentialRoutes(
      {
        insert: (_t: unknown) => ({ values: () => Promise.resolve() }),
        select: () => ({ from: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      } as unknown as import("@nexus/db").Db,
      { encryptionKey: TEST_KEY },
    );

    const nonLoopbackRequest = new Request("http://192.168.1.100:7400/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "x", name: "x", type: "anthropic", value: "sk-test" }),
    });

    const response = await handleAddCredential(nonLoopbackRequest);
    expect(response.status).toBe(426);
    expect(response.headers.get("Upgrade")).toContain("HTTPS");

    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/TLS/i);
  });

  it("[6.2] loopback HTTP request passes TLS check", async () => {
    const { handleAddCredential, initCredentialRoutes, resetCredentialRoutes } = await import("../routes/credentials");
    resetCredentialRoutes();

    initCredentialRoutes(
      {
        insert: (_t: unknown) => ({ values: () => Promise.resolve() }),
        select: () => ({ from: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      } as unknown as import("@nexus/db").Db,
      { encryptionKey: TEST_KEY },
    );

    const loopbackRequest = new Request("http://127.0.0.1:7400/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: `loop-${Date.now()}`, name: "loopback-test", type: "anthropic", value: "sk-test" }),
    });

    const response = await handleAddCredential(loopbackRequest);
    expect(response.status).not.toBe(426);
  });

  it("[6.2] HTTPS request passes TLS check", async () => {
    const { handleAddCredential, initCredentialRoutes, resetCredentialRoutes } = await import("../routes/credentials");
    resetCredentialRoutes();

    initCredentialRoutes(
      {
        insert: (_t: unknown) => ({ values: () => Promise.resolve() }),
        select: () => ({ from: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      } as unknown as import("@nexus/db").Db,
      { encryptionKey: TEST_KEY },
    );

    const httpsRequest = new Request("https://myserver.tailscale.net:7400/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: `https-${Date.now()}`, name: "https-test", type: "anthropic", value: "sk-test" }),
    });

    const response = await handleAddCredential(httpsRequest);
    expect(response.status).not.toBe(426);
  });
});
