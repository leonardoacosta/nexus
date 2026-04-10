/**
 * Credential health check endpoint tests (unit — no PG).
 *
 * Tests GET /credentials/{id}/health responses for valid tokens,
 * revoked tokens, and missing credentials.
 */

import { describe, expect, it, afterEach, mock } from "bun:test";
import { encrypt } from "./encryption";
import { TEST_KEY } from "./credentials.helpers";

// ─── Health check endpoint (unit — no PG) ────────────────────────────────────

describe("credential routes — health check endpoint (unit)", () => {
  afterEach(async () => {
    const { resetCredentialRoutes } = await import("../routes/credentials");
    resetCredentialRoutes();
  });

  // [12.6] GET /credentials/{id}/health returns healthy:true on valid token, healthy:false on revoked
  it("[12.6] returns { healthy: true } when Anthropic API accepts the token", async () => {
    const { handleCredentialHealth, initCredentialRoutes } = await import("../routes/credentials");

    const encryptedToken = encrypt("sk-valid-token", TEST_KEY);

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{
              id: "cred-health-1",
              name: "health-test",
              type: "anthropic",
              valueEncrypted: encryptedToken,
              encryptionKeyId: "v1",
              status: "available",
              leasedBy: null,
              leasedAt: null,
              cooldownUntil: null,
              rateLimitCount: 0,
            }]),
          }),
        }),
      }),
    } as unknown as import("@nexus/db").Db;

    initCredentialRoutes(mockDb, { encryptionKey: TEST_KEY });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string | URL | Request, _opts?: RequestInit) =>
      new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;

    const request = new Request("https://localhost:7400/credentials/cred-health-1/health");
    const response = await handleCredentialHealth("cred-health-1", request);
    const body = await response.json() as { healthy: boolean; checked_at: string };

    expect(response.status).toBe(200);
    expect(body.healthy).toBe(true);
    expect(typeof body.checked_at).toBe("string");

    globalThis.fetch = originalFetch;
  });

  it("[12.6] returns { healthy: false } when Anthropic API returns 401 (revoked token)", async () => {
    const { handleCredentialHealth, initCredentialRoutes } = await import("../routes/credentials");

    const encryptedToken = encrypt("sk-revoked-token", TEST_KEY);

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{
              id: "cred-health-2",
              name: "health-revoked",
              type: "anthropic",
              valueEncrypted: encryptedToken,
              encryptionKeyId: "v1",
              status: "available",
              leasedBy: null,
              leasedAt: null,
              cooldownUntil: null,
              rateLimitCount: 0,
            }]),
          }),
        }),
      }),
    } as unknown as import("@nexus/db").Db;

    initCredentialRoutes(mockDb, { encryptionKey: TEST_KEY });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string | URL | Request, _opts?: RequestInit) =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    ) as unknown as typeof fetch;

    const request = new Request("https://localhost:7400/credentials/cred-health-2/health");
    const response = await handleCredentialHealth("cred-health-2", request);
    const body = await response.json() as { healthy: boolean; checked_at: string };

    expect(response.status).toBe(200);
    expect(body.healthy).toBe(false);

    globalThis.fetch = originalFetch;
  });

  it("[12.6] returns 404 when credential not found", async () => {
    const { handleCredentialHealth, initCredentialRoutes } = await import("../routes/credentials");

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    } as unknown as import("@nexus/db").Db;

    initCredentialRoutes(mockDb, { encryptionKey: TEST_KEY });

    const request = new Request("https://localhost:7400/credentials/nonexistent/health");
    const response = await handleCredentialHealth("nonexistent", request);

    expect(response.status).toBe(404);
  });
});
