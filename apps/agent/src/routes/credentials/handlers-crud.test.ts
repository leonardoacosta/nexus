/**
 * Unit tests for handleListCredentials dedupe + usage passthrough.
 *
 * Spec: credentials-account-resolve-and-usage (task 2.10)
 *
 * Without a live PG scratch schema, we drive the handler with a stubbed
 * `poolRef.current.list()` so the dedupe collapse logic + usage-field
 * passthrough can be asserted in isolation from the DB. The pool's
 * `list()` contract is owned by `pool-core.ts`; these tests treat it as
 * a fixed return value.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { handleListCredentials } from "./handlers-crud";
import { handleLeaseCredential } from "./handlers-lease";
import { poolRef } from "./shared";

interface CredentialRowFixture {
  id: string;
  name: string;
  fingerprint: string;
  duplicateGroupId: string | null;
  isPrimary: boolean;
  status: string;
  // Usage column passthrough fixtures
  usage5hUsed?: number | null;
  usage5hLimit?: number | null;
  usage5hResetAt?: Date | null;
  usage7dUsed?: number | null;
  usage7dLimit?: number | null;
  usage7dResetAt?: Date | null;
  usagePolledAt?: Date | null;
}

interface FakeListEnvelope {
  // Response envelope: Date columns are serialized to ISO strings by Bun's
  // Response.json(), so override the date-typed usage fields here.
  credentials: Array<
    Omit<CredentialRowFixture, "usage5hResetAt" | "usage7dResetAt" | "usagePolledAt"> & {
      siblingCount?: number;
      siblingIds?: string[];
      rateLimit429Count: number;
      isActive: boolean;
      lastSwapAt: string | null;
      usage5hResetAt?: string | null;
      usage7dResetAt?: string | null;
      usagePolledAt?: string | null;
    }
  >;
  activeFingerprint: string | null;
}

function installFakePool(rows: CredentialRowFixture[]): void {
  // Minimal pool surface used by handleListCredentials. Cast-through-unknown
  // is acceptable for a unit-level fake; full integration covered E2E.
  poolRef.current = {
    list: async () => rows,
    stopCleanup: () => {},
  } as unknown as typeof poolRef.current;
}

const ORIGINAL_HOME = process.env.HOME;

describe("handleListCredentials", () => {
  beforeEach(() => {
    // Disable filesystem-fallback so an empty pool doesn't fall through.
    process.env.HOME = "/tmp/nonexistent-home-for-credential-tests";
  });

  afterEach(() => {
    poolRef.current = null;
    if (ORIGINAL_HOME) process.env.HOME = ORIGINAL_HOME;
  });

  it("default behaviour returns every row (no siblingCount field)", async () => {
    const rows: CredentialRowFixture[] = [
      {
        id: "a",
        name: "primary",
        fingerprint: "fp-1",
        duplicateGroupId: "fp-1",
        isPrimary: true,
        status: "available",
      },
      {
        id: "b",
        name: "sibling",
        fingerprint: "fp-1",
        duplicateGroupId: "fp-1",
        isPrimary: false,
        status: "available",
      },
    ];
    installFakePool(rows);

    const res = await handleListCredentials();
    expect(res.status).toBe(200);
    const body = (await res.json()) as FakeListEnvelope;
    expect(body.credentials.length).toBe(2);
    // No sibling fields on default response — byte-for-byte back-compat.
    expect(body.credentials[0]).not.toHaveProperty("siblingCount");
    expect(body.credentials[1]).not.toHaveProperty("siblingCount");
  });

  it("?dedupe=true collapses a 3-row group to 1 with siblingCount=2", async () => {
    const rows: CredentialRowFixture[] = [
      {
        id: "p",
        name: "primary",
        fingerprint: "fp-1",
        duplicateGroupId: "fp-1",
        isPrimary: true,
        status: "available",
      },
      {
        id: "s1",
        name: "sib-1",
        fingerprint: "fp-1",
        duplicateGroupId: "fp-1",
        isPrimary: false,
        status: "available",
      },
      {
        id: "s2",
        name: "sib-2",
        fingerprint: "fp-1",
        duplicateGroupId: "fp-1",
        isPrimary: false,
        status: "available",
      },
    ];
    installFakePool(rows);

    const req = new Request("http://localhost/credentials?dedupe=true");
    const res = await handleListCredentials(req);
    const body = (await res.json()) as FakeListEnvelope;
    expect(body.credentials.length).toBe(1);
    expect(body.credentials[0]!.id).toBe("p");
    expect(body.credentials[0]!.siblingCount).toBe(2);
    expect(body.credentials[0]!.siblingIds).toEqual(["s1", "s2"]);
  });

  it("?dedupe=true assigns siblingCount=0 to a primary with no duplicates", async () => {
    const rows: CredentialRowFixture[] = [
      {
        id: "lone",
        name: "lone-primary",
        fingerprint: "fp-x",
        duplicateGroupId: "fp-x",
        isPrimary: true,
        status: "available",
      },
    ];
    installFakePool(rows);

    const req = new Request("http://localhost/credentials?dedupe=true");
    const res = await handleListCredentials(req);
    const body = (await res.json()) as FakeListEnvelope;
    expect(body.credentials.length).toBe(1);
    expect(body.credentials[0]!.siblingCount).toBe(0);
    expect(body.credentials[0]!.siblingIds).toEqual([]);
  });

  it("usage columns ride through on every row (default + dedupe)", async () => {
    const reset = new Date("2030-01-01T00:00:00Z");
    const polled = new Date("2026-01-01T00:00:00Z");
    const rows: CredentialRowFixture[] = [
      {
        id: "p",
        name: "primary",
        fingerprint: "fp-1",
        duplicateGroupId: "fp-1",
        isPrimary: true,
        status: "available",
        usage5hUsed: 41,
        usage5hLimit: 50,
        usage5hResetAt: reset,
        usage7dUsed: 220,
        usage7dLimit: 1000,
        usage7dResetAt: reset,
        usagePolledAt: polled,
      },
      {
        id: "blank",
        name: "no-poll-yet",
        fingerprint: "fp-2",
        duplicateGroupId: "fp-2",
        isPrimary: true,
        status: "available",
      },
    ];
    installFakePool(rows);

    const def = await handleListCredentials();
    const defBody = (await def.json()) as FakeListEnvelope;
    const defPrimary = defBody.credentials.find((r) => r.id === "p")!;
    expect(defPrimary.usage5hUsed).toBe(41);
    expect(defPrimary.usage7dLimit).toBe(1000);
    expect(defPrimary.usagePolledAt).toBe(polled.toISOString());
    const defBlank = defBody.credentials.find((r) => r.id === "blank")!;
    expect(defBlank.usage5hUsed ?? null).toBeNull();

    const req = new Request("http://localhost/credentials?dedupe=true");
    const ded = await handleListCredentials(req);
    const dedBody = (await ded.json()) as FakeListEnvelope;
    const dedPrimary = dedBody.credentials.find((r) => r.id === "p")!;
    expect(dedPrimary.usage5hUsed).toBe(41);
    expect(dedPrimary.siblingCount).toBe(0);
  });
});

// ── Lease route TLS gate (plan 004 sub-fix A) ────────────────────────────────
//
// POST /credentials/lease returns a DECRYPTED credential, so it must be gated
// at least as strictly as the add route: non-loopback http:// -> 426. A pool
// must be installed so the TLS check (which runs after the pool-null guard)
// is actually reached rather than short-circuiting on a 500.
describe("handleLeaseCredential — TLS gate", () => {
  beforeEach(() => {
    // Pool returning null on lease() — proves the gate fires before lease()
    // for the 426 case, and yields a non-426 (409) for the loopback case.
    poolRef.current = {
      lease: async () => null,
      stopCleanup: () => {},
    } as unknown as typeof poolRef.current;
  });

  afterEach(() => {
    poolRef.current = null;
  });

  it("rejects non-loopback http:// with 426", async () => {
    const req = new Request("http://10.0.0.5:7400/credentials/lease", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "anthropic", leased_by: "attacker" }),
    });
    const res = await handleLeaseCredential(req);
    expect(res.status).toBe(426);
  });

  it("allows loopback http:// (not 426'd)", async () => {
    const req = new Request("http://127.0.0.1:7400/credentials/lease", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "anthropic", leased_by: "caller" }),
    });
    const res = await handleLeaseCredential(req);
    expect(res.status).not.toBe(426);
  });
});
