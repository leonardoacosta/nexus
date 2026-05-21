/**
 * Unit tests for the refresh-identity handlers.
 *
 * Spec: credentials-account-resolve-and-usage (task 2.7)
 *
 * Without a Postgres scratch schema available in this test runner, these
 * tests focus on the pool-not-initialized contract. Full happy-path
 * coverage (blank-row populates, populated-row overwrites, 401 → 502,
 * all-endpoint skips non-blank rows) is exercised end-to-end against a
 * homelab agent in tasks 4.2.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import {
  handleRefreshIdentity,
  handleRefreshIdentityAll,
} from "./handlers-refresh-identity";
import { resetCredentialRoutes } from "./init";

describe("handleRefreshIdentity — pool not initialized", () => {
  beforeEach(() => {
    resetCredentialRoutes();
  });

  it("returns 500 when pool is not initialised", async () => {
    const res = await handleRefreshIdentity("cred-xyz");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("credential system not initialized");
  });
});

describe("handleRefreshIdentityAll — pool not initialized", () => {
  beforeEach(() => {
    resetCredentialRoutes();
  });

  it("returns 500 when pool is not initialised", async () => {
    const res = await handleRefreshIdentityAll();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("credential system not initialized");
  });
});
