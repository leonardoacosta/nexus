/**
 * E2E [SpecA 5.1] (nx-j2x4): Account-first grouping via `fetchCredentials()`.
 *
 * Pins the contract that `apps/nextjs/src/app/actions/credentials.ts`
 * collapses N credential files into N accounts keyed by OAuth refresh-token
 * fingerprint. The server action previously returned a flat list of files,
 * which confused the UI when multiple slots held the same credential. The
 * refine-credential-page-grouping change reshaped the server action output
 * so `accounts.length === unique fingerprints` and each account's
 * `snapshots[]` bundles every file that shares the same fingerprint.
 *
 * Strategy:
 *   1. Stand up a minimal mock agent HTTP server on a random port that
 *      responds to:
 *        - GET /credentials        — envelope with 5 rows across 3 fingerprints
 *        - GET /credentials/:id/usage — null (we don't assert usage here)
 *   2. Point the Next.js agent registry at that port via a module mock.
 *   3. Invoke the real `fetchCredentials()` server action unmodified.
 *   4. Assert account cardinality + snapshot grouping.
 *
 * This is the right integration level: we exercise the real grouping logic
 * (`groupByFingerprint`, `toCredentialFile`, primary sorting) without
 * requiring a live Postgres or a real agent.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  mock,
} from "bun:test";

// ─── Mock the agent-registry lookup so fetchCredentials() hits our fixture ──

const FIXTURE_PORT = { value: 0 };

// fetchCredentials() imports from `@/lib/get-client`, which the Next.js app
// resolves via tsconfig paths. Bun's bare-test runner doesn't apply tsconfig
// path aliases, so we register the mock under BOTH import specifiers: the
// relative path (how bun resolves it from the action file) and the alias
// (so even if alias resolution is added later we stay consistent).
const mockGetClient = () => ({
  // fetchCredentials() calls getAgentConfigs() -> tries each agent.
  // We return our single fixture agent pointing at Bun.serve port.
  getAgentConfigs: async () => [
    { name: "fixture", host: "127.0.0.1", port: FIXTURE_PORT.value },
  ],
  // Unused by fetchCredentials but exported for completeness.
  getClient: async () => ({} as unknown),
  getAgentHost: async () => null,
});

mock.module("../../apps/nextjs/src/lib/get-client", mockGetClient);
mock.module("@/lib/get-client", mockGetClient);

// Import AFTER the module mock so the action binds to the mocked module.
const { fetchCredentials } = await import(
  "../../apps/nextjs/src/app/actions/credentials"
);

// ─── Fixture data ───────────────────────────────────────────────────────────

/** Fingerprint A is shared by two files — primary + one duplicate. */
const FP_A = "a".repeat(64);
/** Fingerprint B is shared by two files — primary + one duplicate. */
const FP_B = "b".repeat(64);
/** Fingerprint C has exactly one file (single-member group). */
const FP_C = "c".repeat(64);

interface WireRow {
  id: string;
  name: string;
  status: string;
  type: string;
  fingerprint: string;
  duplicateGroupId: string | null;
  isPrimary: boolean;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  expiresAt: string | null;
  accountEmail: string | null;
  accountName: string | null;
  accountUuid: string | null;
  orgName: string | null;
  orgUuid: string | null;
  mcpProviders: string | null;
  rateLimitCount: number;
  leasedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function row(overrides: Partial<WireRow> & Pick<WireRow, "id" | "fingerprint">): WireRow {
  const base: WireRow = {
    id: overrides.id,
    name: `cred-${overrides.id}`,
    status: "available",
    type: "oauth",
    fingerprint: overrides.fingerprint,
    duplicateGroupId: overrides.fingerprint,
    isPrimary: true,
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    expiresAt: null,
    accountEmail: null,
    accountName: null,
    accountUuid: null,
    orgName: null,
    orgUuid: null,
    mcpProviders: null,
    rateLimitCount: 0,
    leasedBy: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
  return { ...base, ...overrides };
}

const FIXTURE_ROWS: WireRow[] = [
  // Fingerprint A — 2 files
  row({ id: "a1", fingerprint: FP_A, isPrimary: true, createdAt: "2026-04-01T00:00:00.000Z" }),
  row({ id: "a2", fingerprint: FP_A, isPrimary: false, createdAt: "2026-04-02T00:00:00.000Z" }),
  // Fingerprint B — 2 files (primary written LATER than duplicate, so we
  // verify primary-first sort doesn't accidentally use createdAt ordering).
  row({ id: "b1", fingerprint: FP_B, isPrimary: false, createdAt: "2026-04-01T00:00:00.000Z" }),
  row({ id: "b2", fingerprint: FP_B, isPrimary: true, createdAt: "2026-04-05T00:00:00.000Z" }),
  // Fingerprint C — 1 file
  row({ id: "c1", fingerprint: FP_C, isPrimary: true }),
];

// ─── Mock agent server ──────────────────────────────────────────────────────

let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/credentials" && req.method === "GET") {
        return new Response(
          JSON.stringify({
            credentials: FIXTURE_ROWS,
            activeFingerprint: FP_B, // arbitrary but tested below
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      // Usage endpoint: return null so the action swallows it per-account.
      if (url.pathname.startsWith("/credentials/") && url.pathname.endsWith("/usage")) {
        return new Response("null", {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  FIXTURE_PORT.value = server.port;
});

afterAll(() => {
  try {
    server?.stop(true);
  } catch {
    // best-effort
  }
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("E2E [SpecA 5.1]: fetchCredentials() account-first grouping", () => {
  test("produces one account per distinct fingerprint", async () => {
    const result = await fetchCredentials();

    expect(result.agentReachable).toBe(true);
    expect(result.totalFiles).toBe(FIXTURE_ROWS.length);
    // 3 distinct fingerprints → 3 accounts (not 5).
    expect(result.accounts).toHaveLength(3);
    expect(result.totalAccounts).toBe(3);

    const fingerprints = result.accounts.map((a) => a.fingerprint).sort();
    expect(fingerprints).toEqual([FP_A, FP_B, FP_C].sort());
  });

  test("each account's snapshots[] groups all same-fingerprint files", async () => {
    const result = await fetchCredentials();

    const byFp = new Map(result.accounts.map((a) => [a.fingerprint, a]));

    // Account A — 2 snapshots.
    const acctA = byFp.get(FP_A);
    expect(acctA).toBeDefined();
    expect(acctA!.snapshots).toHaveLength(2);
    const aIds = new Set(acctA!.snapshots.map((s) => s.id));
    expect(aIds).toEqual(new Set(["a1", "a2"]));

    // Account B — 2 snapshots.
    const acctB = byFp.get(FP_B);
    expect(acctB).toBeDefined();
    expect(acctB!.snapshots).toHaveLength(2);
    const bIds = new Set(acctB!.snapshots.map((s) => s.id));
    expect(bIds).toEqual(new Set(["b1", "b2"]));

    // Account C — 1 snapshot.
    const acctC = byFp.get(FP_C);
    expect(acctC).toBeDefined();
    expect(acctC!.snapshots).toHaveLength(1);
    expect(acctC!.snapshots[0]!.id).toBe("c1");
  });

  test("primary snapshot is first in each account's snapshots[] regardless of createdAt", async () => {
    const result = await fetchCredentials();
    const byFp = new Map(result.accounts.map((a) => [a.fingerprint, a]));

    // Account B's primary (b2) was created LATER than its duplicate (b1),
    // so a naive createdAt sort would put b1 first. Primary-first sort
    // must put b2 first.
    const acctB = byFp.get(FP_B)!;
    expect(acctB.snapshots[0]!.id).toBe("b2");
    expect(acctB.snapshots[0]!.isPrimary).toBe(true);
    expect(acctB.snapshots[1]!.id).toBe("b1");
    expect(acctB.snapshots[1]!.isPrimary).toBe(false);
  });

  test("exactly one account is flagged isActiveForCc based on activeFingerprint", async () => {
    const result = await fetchCredentials();

    expect(result.activeFingerprint).toBe(FP_B);

    const active = result.accounts.filter((a) => a.isActiveForCc);
    expect(active).toHaveLength(1);
    expect(active[0]!.fingerprint).toBe(FP_B);

    // Other accounts are NOT active.
    const inactive = result.accounts.filter((a) => !a.isActiveForCc);
    expect(inactive.map((a) => a.fingerprint).sort()).toEqual([FP_A, FP_C].sort());
  });
});
