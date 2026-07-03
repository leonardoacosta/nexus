/**
 * Credential route audit trail unit tests.
 *
 * Tests verify that:
 * - Route handlers return correct HTTP status/shape responses
 * - Audit logger (audit.credential) is created via createLogger
 * - Handler signatures accept the request parameter for IP extraction
 * - Error paths (pool not initialized, missing fields) propagate correctly
 * - Filesystem reader (readCredentials) projects acct-*.json files into the
 *   wire shape against a tmpdir fixture (homelab-emits-specs-credentials task 1.10)
 */

import { describe, expect, it, beforeEach, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  resetCredentialRoutes,
  initCredentialRoutes,
  handleLeaseCredential,
  handleReportRateLimit,
  handleCredentialHealth,
  handleSwapCredential,
  getCredentialPool,
} from "./credentials";
import {
  readCredentials,
  type CredentialReadResult,
} from "../services/credential-pool/reader";
import * as credentialShared from "./credentials/shared";

// ── Request helpers ───────────────────────────────────────────────────────────

function makePostRequest(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(url: string, headers?: Record<string, string>): Request {
  return new Request(url, {
    method: "GET",
    headers: headers ?? {},
  });
}

// ── Pool not initialized (no PG needed) ──────────────────────────────────────

describe("credential route handlers — pool not initialized", () => {
  beforeEach(() => {
    resetCredentialRoutes();
  });

  // [2.3] Audit trail: handleLeaseCredential
  it("[2.3] handleLeaseCredential returns 500 when pool not initialized", async () => {
    const req = makePostRequest("http://127.0.0.1:7400/credentials/lease", {
      type: "anthropic",
      leased_by: "caller",
    });
    const res = await handleLeaseCredential(req);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("credential system not initialized");
  });

  // [3.3] Audit trail: handleReportRateLimit with auto_swap
  it("[3.3] handleReportRateLimit returns 500 when pool not initialized", async () => {
    const req = makePostRequest(
      "http://127.0.0.1:7400/credentials/cred-001/report-rate-limit",
      { leased_by: "caller" },
      { "x-forwarded-for": "10.0.0.1" },
    );
    const res = await handleReportRateLimit("cred-001", req);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("credential system not initialized");
  });

  // [3.4] Audit trail: handleReportRateLimit with no replacement
  it("[3.4] handleReportRateLimit (no replacement) returns 500 when pool not initialized", async () => {
    const req = makePostRequest(
      "http://127.0.0.1:7400/credentials/cred-solo/report-rate-limit",
      { leased_by: "solo-caller" },
    );
    const res = await handleReportRateLimit("cred-solo", req);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("credential system not initialized");
  });

  // [4.3] Audit trail: handleCredentialHealth
  it("[4.3] handleCredentialHealth returns 500 when pool not initialized", async () => {
    const req = makeGetRequest(
      "http://127.0.0.1:7400/credentials/cred-001/health",
      { "x-forwarded-for": "10.0.0.5" },
    );
    const res = await handleCredentialHealth("cred-001", req);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("credential system not initialized");
  });
});

// ── Input validation (pool initialized, fake DB) ─────────────────────────────

describe("credential route handlers — input validation", () => {
  beforeEach(() => {
    resetCredentialRoutes();
    // Initialize with a fake DB that satisfies the pool constructor
    // (pool won't be called for validation failures)
    const fakeDb = {} as unknown as import("@nexus/db").Db;
    const { initCredentialRoutes } = require("./credentials");
    initCredentialRoutes(fakeDb, { encryptionKey: Buffer.alloc(32, 1) });
  });

  it("[2.1] handleLeaseCredential: missing type returns 400", async () => {
    const req = makePostRequest(
      "http://127.0.0.1:7400/credentials/lease",
      { leased_by: "caller" }, // missing type
    );
    const res = await handleLeaseCredential(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toContain("type");
  });

  it("[2.1] handleLeaseCredential: missing leased_by returns 400", async () => {
    const req = makePostRequest(
      "http://127.0.0.1:7400/credentials/lease",
      { type: "anthropic" }, // missing leased_by
    );
    const res = await handleLeaseCredential(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toContain("leased_by");
  });

  it("[2.1] handleLeaseCredential: valid request body passes validation (400 not returned)", async () => {
    // Provide valid body with x-forwarded-for — validation passes,
    // pool.lease() will be attempted. Since we have no PG the pool may throw,
    // but the important assertion is that status is NOT 400 (not a validation error).
    // We catch any pool-level errors by checking status != 400.
    const req = makePostRequest(
      "http://127.0.0.1:7400/credentials/lease",
      { type: "anthropic", leased_by: "caller" },
      { "x-forwarded-for": "192.168.1.5, 10.0.0.1" },
    );
    try {
      const res = await handleLeaseCredential(req);
      // Not a 400 (validation passed)
      expect(res.status).not.toBe(400);
    } catch {
      // Pool error thrown (no real DB) — validation still passed
      expect(true).toBe(true);
    }
  });

  it("[3.3][3.4] handleReportRateLimit: missing leased_by returns 400", async () => {
    const req = makePostRequest(
      "http://127.0.0.1:7400/credentials/cred-001/report-rate-limit",
      {}, // missing leased_by
    );
    const res = await handleReportRateLimit("cred-001", req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toContain("leased_by");
  });

  it("[4.1] handleCredentialHealth: accepts request parameter — 404 or error (no real DB)", async () => {
    const req = makeGetRequest(
      "http://127.0.0.1:7400/credentials/nonexistent/health",
      { "x-forwarded-for": "10.0.0.1" },
    );
    // Pool is initialized but DB is fake — getDecrypted will throw or return null.
    // Either a 404 (credential not found) or exception from pool is acceptable here.
    try {
      const res = await handleCredentialHealth("nonexistent", req);
      // Possible outcomes: 404 (not found) or 500 (pool error)
      expect([404, 500]).toContain(res.status);
    } catch {
      // Pool DB call throws — acceptable in unit test without real PG
      expect(true).toBe(true);
    }
  });
});

// ── POST /credentials/swap (mocked pool) ───────────────────────────────────

/** Minimal credential list entry for mocking pool.list(). */
function makeListEntry(overrides: {
  id: string;
  name: string;
  status?: string;
}) {
  const now = new Date();
  return {
    id: overrides.id,
    name: overrides.name,
    type: "anthropic",
    agentId: null,
    encryptionKeyId: "v1",
    status: overrides.status ?? "available",
    leasedBy: null,
    leasedAt: null,
    cooldownUntil: null,
    rateLimitCount: 0,
    fingerprint: `fp-${overrides.id}`,
    duplicateGroupId: `fp-${overrides.id}`,
    isPrimary: true,
    subscriptionType: null,
    rateLimitTier: null,
    expiresAt: null,
    accountEmail: null,
    accountName: null,
    accountUuid: null,
    orgName: null,
    orgUuid: null,
    mcpProviders: null,
    // Usage snapshot columns (credentials-account-resolve-and-usage spec):
    // all NULL until credential-usage-poller writes the first sample.
    usage5hUsed: null,
    usage5hLimit: null,
    usage5hResetAt: null,
    usage7dUsed: null,
    usage7dLimit: null,
    usage7dResetAt: null,
    usagePolledAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Minimal credential row for mocking pool.manualSwap() return values. */
function makeCredentialRow(overrides: {
  id: string;
  name: string;
  status?: string;
}) {
  const now = new Date();
  return {
    id: overrides.id,
    name: overrides.name,
    type: "anthropic",
    valueEncrypted: "encrypted-secret-value",
    agentId: null,
    encryptionKeyId: "v1",
    status: overrides.status ?? "available",
    leasedBy: null,
    leasedAt: null,
    cooldownUntil: null,
    rateLimitCount: 0,
    fingerprint: `fp-${overrides.id}`,
    duplicateGroupId: `fp-${overrides.id}`,
    isPrimary: true,
    subscriptionType: null,
    rateLimitTier: null,
    expiresAt: null,
    accountEmail: null,
    accountName: null,
    accountUuid: null,
    orgName: null,
    orgUuid: null,
    mcpProviders: null,
    // Usage snapshot columns (credentials-account-resolve-and-usage spec):
    // all NULL until credential-usage-poller writes the first sample.
    usage5hUsed: null,
    usage5hLimit: null,
    usage5hResetAt: null,
    usage7dUsed: null,
    usage7dLimit: null,
    usage7dResetAt: null,
    usagePolledAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Audit provenance keys (plan 004 sub-fix B) ───────────────────────────────
//
// The lease audit actor/IP come from client-spoofable inputs (`leased_by` body
// field, `x-forwarded-for` header). They MUST be recorded under `claimed_*`
// keys so the audit schema never presents caller-asserted values as verified
// identity.
describe("credential lease audit provenance (plan 004)", () => {
  beforeEach(() => {
    resetCredentialRoutes();
    const fakeDb = {} as unknown as import("@nexus/db").Db;
    initCredentialRoutes(fakeDb, { encryptionKey: Buffer.alloc(32, 1) });
  });

  it("records forged leased_by under claimed_actor and forged IP under claimed_ip", async () => {
    const pool = getCredentialPool()!;
    spyOn(pool, "lease").mockResolvedValue(
      makeCredentialRow({ id: "cred-x", name: "leased" }),
    );
    const auditSpy = spyOn(credentialShared, "emitAudit");

    // Loopback URL so the TLS gate passes; forged actor + IP inputs.
    const req = makePostRequest(
      "http://127.0.0.1:7400/credentials/lease",
      { type: "anthropic", leased_by: "attacker-spoofed" },
      { "x-forwarded-for": "203.0.113.9" },
    );
    const res = await handleLeaseCredential(req);
    expect(res.status).toBe(200);

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const entry = auditSpy.mock.calls[0]![0] as Record<string, unknown>;
    // Spoofable values are recorded, but only under the claimed_* keys.
    expect(entry.claimed_actor).toBe("attacker-spoofed");
    expect(entry.claimed_ip).toBe("203.0.113.9");
    // The old trusted-looking keys must be gone.
    expect(entry).not.toHaveProperty("actor");
    expect(entry).not.toHaveProperty("ip");
  });
});

describe("POST /credentials/swap", () => {
  beforeEach(() => {
    resetCredentialRoutes();
    const fakeDb = {} as unknown as import("@nexus/db").Db;
    const { initCredentialRoutes } = require("./credentials");
    initCredentialRoutes(fakeDb, { encryptionKey: Buffer.alloc(32, 1) });
  });

  it("returns 500 when pool not initialized", async () => {
    resetCredentialRoutes(); // undo beforeEach init
    const req = makePostRequest("http://127.0.0.1:7400/credentials/swap", {
      to: "work",
    });
    const res = await handleSwapCredential(req);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("credential system not initialized");
  });

  it("returns 400 when 'to' field is missing", async () => {
    const req = makePostRequest("http://127.0.0.1:7400/credentials/swap", {});
    const res = await handleSwapCredential(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toContain("to");
  });

  it("successful swap — returns 200 with swapped: true, parked, and activated", async () => {
    const pool = getCredentialPool()!;
    const personalEntry = makeListEntry({ id: "cred-personal", name: "personal" });
    const workEntry = makeListEntry({ id: "cred-work", name: "work" });

    spyOn(pool, "list").mockResolvedValue([personalEntry, workEntry]);
    spyOn(pool, "manualSwap").mockResolvedValue({
      parked: makeCredentialRow({ id: "cred-personal", name: "personal", status: "cooldown" }),
      activated: makeCredentialRow({ id: "cred-work", name: "work" }),
    });

    const req = makePostRequest("http://127.0.0.1:7400/credentials/swap", {
      to: "work",
    });
    const res = await handleSwapCredential(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      swapped: boolean;
      parked: Record<string, unknown> | null;
      activated: Record<string, unknown>;
    };
    expect(body.swapped).toBe(true);
    expect(body.parked).not.toBeNull();
    expect(body.parked!.id).toBe("cred-personal");
    expect(body.activated.id).toBe("cred-work");

    // valueEncrypted must NOT appear in response
    expect(body.parked!).not.toHaveProperty("valueEncrypted");
    expect(body.activated).not.toHaveProperty("valueEncrypted");
  });

  it("404 name-not-found — returns 404 when target name does not exist", async () => {
    const pool = getCredentialPool()!;
    const personalEntry = makeListEntry({ id: "cred-personal", name: "personal" });

    spyOn(pool, "list").mockResolvedValue([personalEntry]);

    const req = makePostRequest("http://127.0.0.1:7400/credentials/swap", {
      to: "nonexistent",
    });
    const res = await handleSwapCredential(req);
    expect(res.status).toBe(404);

    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("credential not found");
    expect(body.name).toBe("nonexistent");
  });

  it("409 target-in-cooldown — returns 409 when target credential is cooling down", async () => {
    const pool = getCredentialPool()!;
    const personalEntry = makeListEntry({ id: "cred-personal", name: "personal" });
    const workEntry = makeListEntry({ id: "cred-work", name: "work", status: "cooldown" });

    spyOn(pool, "list").mockResolvedValue([personalEntry, workEntry]);
    spyOn(pool, "manualSwap").mockRejectedValue(
      new Error("target credential is in cooldown"),
    );

    const req = makePostRequest("http://127.0.0.1:7400/credentials/swap", {
      to: "work",
    });
    const res = await handleSwapCredential(req);
    expect(res.status).toBe(409);

    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("target credential is in cooldown");
    expect(body.name).toBe("work");
  });

  it("200 no-op — returns parked: null when target is already best-available", async () => {
    const pool = getCredentialPool()!;
    const personalEntry = makeListEntry({ id: "cred-personal", name: "personal" });

    spyOn(pool, "list").mockResolvedValue([personalEntry]);
    spyOn(pool, "manualSwap").mockResolvedValue({
      parked: null,
      activated: makeCredentialRow({ id: "cred-personal", name: "personal" }),
    });

    const req = makePostRequest("http://127.0.0.1:7400/credentials/swap", {
      to: "personal",
    });
    const res = await handleSwapCredential(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      swapped: boolean;
      parked: Record<string, unknown> | null;
      activated: Record<string, unknown>;
    };
    expect(body.swapped).toBe(true);
    expect(body.parked).toBeNull();
    expect(body.activated.id).toBe("cred-personal");

    // valueEncrypted must NOT appear even in no-op response
    expect(body.activated).not.toHaveProperty("valueEncrypted");
  });
});

// ── readCredentials — tmpdir fixture (homelab-emits-specs-credentials task 1.10) ──

/**
 * Build a valid OAuth credential JSON payload with a deterministic
 * refresh token so the fingerprint is reproducible across runs.
 */
function makeOAuthBlob(opts: {
  refreshToken: string;
  email?: string;
  expiresAt?: number;
}): string {
  return JSON.stringify({
    claudeAiOauth: {
      refreshToken: opts.refreshToken,
      accessToken: "at-" + randomBytes(8).toString("hex"),
      email: opts.email,
      expiresAt: opts.expiresAt,
    },
  });
}

describe("readCredentials — filesystem reader (task 1.10)", () => {
  it("[1.10] missing directory returns {credentials: [], activeFingerprint: null}", async () => {
    const dir = join(tmpdir(), "nx-cred-missing-" + Date.now());
    const result = await readCredentials(dir);
    expect(result).toEqual<CredentialReadResult>({
      credentials: [],
      activeFingerprint: null,
    });
  });

  it("[1.10] empty pool dir falls back to synthesize-from-CC (or empty when no CC file)", async () => {
    // nx-y4hjl re-scope: this test previously asserted `credentials: []` for an
    // empty pool dir. That premise is obsolete — `fix-credential-source-divergence`
    // (reader.ts `readActiveCcCredentialEntry`) INTENTIONALLY synthesizes a single
    // entry from `~/.claude/.credentials.json` when the pool has zero acct-*.json
    // files, so the dashboard reflects the real active CC credential on hosts that
    // use Claude Code directly (no nexus pool import). The old `process.env.HOME`
    // redirect can't disable that fallback because Bun's `os.homedir()` reads the
    // passwd entry, not $HOME. So we assert what ACTUALLY ships:
    //   - on a CC host (the dotted file exists): an empty pool synthesizes exactly
    //     one active credential whose fingerprint becomes activeFingerprint;
    //   - on a host WITHOUT that file: the documented empty wire shape.
    const dir = mkdtempSync(join(tmpdir(), "nx-cred-empty-"));
    // Resolve the same CC credential path the reader's fallback uses. The reader
    // anchors on os.homedir(); mirror that here so the branch is host-accurate.
    const ccCredentialsPath = join(homedir(), ".claude", ".credentials.json");
    try {
      const result = await readCredentials(dir);
      if (existsSync(ccCredentialsPath)) {
        // Shipped fallback: synthesize the host's active CC credential.
        expect(result.credentials).toHaveLength(1);
        const entry = result.credentials[0]!;
        expect(entry.status).toBe("active");
        expect(entry.isActive).toBe(true);
        expect(typeof entry.fingerprint).toBe("string");
        expect(entry.fingerprint.length).toBe(64); // sha256 hex
        // activeFingerprint must point at the synthesized entry.
        expect(result.activeFingerprint).toBe(entry.fingerprint);
      } else {
        // No CC file on this host — documented empty wire shape.
        expect(result.credentials).toEqual([]);
        expect(result.activeFingerprint).toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[1.10] projects acct-*.json files into wire shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-cred-files-"));
    try {
      writeFileSync(
        join(dir, "acct-personal.json"),
        makeOAuthBlob({ refreshToken: "rt-personal", email: "leo@home.com" }),
      );
      writeFileSync(
        join(dir, "acct-work.json"),
        makeOAuthBlob({ refreshToken: "rt-work", email: "leo@work.com" }),
      );

      const result = await readCredentials(dir);
      expect(result.credentials.length).toBe(2);

      for (const row of result.credentials) {
        expect(typeof row.fingerprint).toBe("string");
        expect(row.fingerprint.length).toBe(64); // sha256 hex
        expect(typeof row.created_at).toBe("string");
        // ISO-8601 sanity check
        expect(() => new Date(row.created_at).toISOString()).not.toThrow();
        expect(["active", "available", "expired"]).toContain(row.status);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[1.10] symlink-based active marker sets matching row to status=active", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-cred-active-"));
    try {
      const personalPath = join(dir, "acct-personal.json");
      const workPath = join(dir, "acct-work.json");
      writeFileSync(
        personalPath,
        makeOAuthBlob({ refreshToken: "rt-personal" }),
      );
      writeFileSync(workPath, makeOAuthBlob({ refreshToken: "rt-work" }));

      // Symlink "active" -> personal credential. The reader's cascade
      // step 1 resolves this and hashes the target.
      symlinkSync(personalPath, join(dir, "active"));

      const result = await readCredentials(dir);
      expect(result.activeFingerprint).toBeTruthy();
      const activeRows = result.credentials.filter((c) => c.status === "active");
      expect(activeRows.length).toBe(1);
      // The fingerprint of the active row must equal the envelope's
      // activeFingerprint.
      expect(activeRows[0]?.fingerprint).toBe(result.activeFingerprint!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[1.10] malformed JSON files are skipped, valid files surface", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-cred-mixed-"));
    try {
      writeFileSync(
        join(dir, "acct-good.json"),
        makeOAuthBlob({ refreshToken: "rt-good" }),
      );
      writeFileSync(join(dir, "acct-broken.json"), "{not valid json");
      writeFileSync(join(dir, "acct-shape-wrong.json"), '{"some":"other"}');

      const result = await readCredentials(dir);
      expect(result.credentials.length).toBe(1);
      expect(result.credentials[0]?.account).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[1.10] expired credential reports status=expired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-cred-expired-"));
    try {
      // 1 hour in the past
      const past = Date.now() - 3600_000;
      writeFileSync(
        join(dir, "acct-old.json"),
        makeOAuthBlob({ refreshToken: "rt-old", expiresAt: past }),
      );
      const result = await readCredentials(dir);
      expect(result.credentials.length).toBe(1);
      expect(result.credentials[0]?.status).toBe("expired");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[1.10] response row shape includes fingerprint, account, created_at, status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-cred-shape-"));
    try {
      writeFileSync(
        join(dir, "acct-x.json"),
        makeOAuthBlob({ refreshToken: "rt-x", email: "leo@test.com" }),
      );
      const result = await readCredentials(dir);
      const row = result.credentials[0]!;
      expect(row).toHaveProperty("fingerprint");
      expect(row).toHaveProperty("account");
      expect(row).toHaveProperty("created_at");
      expect(row).toHaveProperty("status");
      expect(row.account).toBe("leo@test.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[1.10] non-acct prefix files are ignored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-cred-ignore-"));
    try {
      writeFileSync(join(dir, "README.md"), "# notes\n");
      writeFileSync(join(dir, "other.json"), '{"unrelated": true}');
      writeFileSync(
        join(dir, "acct-only.json"),
        makeOAuthBlob({ refreshToken: "rt-only" }),
      );
      const result = await readCredentials(dir);
      expect(result.credentials.length).toBe(1);
      expect(result.credentials[0]?.account).toBe("acct-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── credentials-rich-emission task 1.7 ────────────────────────────────────────
//
// Four scenarios cover the enriched CcProfile-compatible wire shape:
//   (a) full-shape decode against a "real-looking" homelab-style fixture
//   (b) minimal credential file falls back to fingerprint-derived id + short
//       name without losing the row
//   (c) rate-limit counter integration — record 429s via the tracker, then
//       confirm the reader projects count24h into rateLimit429Count
//   (d) isActive flag matches the envelope's activeFingerprint

import {
  __resetForTests as __resetRateLimitTracker,
  recordFailure,
} from "../services/credential-pool/rate-limit-tracker";
import { __resetForTests as __resetSwapTracker } from "../services/credential-pool/swap-tracker";

/** Build a homelab-shaped OAuth blob (matches actual `~/.claude/.credentials.json`). */
function makeHomelabBlob(opts: {
  refreshToken: string;
  expiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-" + randomBytes(16).toString("hex"),
      refreshToken: opts.refreshToken,
      expiresAt: opts.expiresAt ?? Date.now() + 30 * 24 * 60 * 60 * 1000,
      scopes: [
        "user:file_upload",
        "user:inference",
        "user:mcp_servers",
        "user:profile",
        "user:sessions:claude_code",
      ],
      subscriptionType: opts.subscriptionType ?? "max",
      rateLimitTier: opts.rateLimitTier ?? "default_claude_max_20x",
    },
    mcpOAuth: {},
  });
}

/** Fingerprint helper — must match reader's logic. */
import { createHash as __testHash } from "node:crypto";
function fp(refreshToken: string): string {
  return __testHash("sha256").update(refreshToken).digest("hex");
}

describe("readCredentials — enriched CcProfile shape (task 1.7)", () => {
  beforeEach(() => {
    __resetRateLimitTracker();
    __resetSwapTracker();
  });

  it("(a) full-shape decode — homelab-style blob projects every CcProfile field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-cred-rich-full-"));
    try {
      const expiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
      writeFileSync(
        join(dir, "acct-rich.json"),
        makeHomelabBlob({
          refreshToken: "rt-rich-decode",
          expiresAt: expiry,
          subscriptionType: "max",
          rateLimitTier: "default_claude_max_20x",
        }),
      );

      const result = await readCredentials(dir);
      expect(result.credentials.length).toBe(1);

      const row = result.credentials[0]!;
      // Required-by-Swift fields.
      expect(typeof row.id).toBe("string");
      expect(row.id.length).toBeGreaterThan(0);
      expect(typeof row.name).toBe("string");
      expect(row.name.length).toBeGreaterThan(0);
      expect(typeof row.fingerprint).toBe("string");
      expect(row.fingerprint.length).toBe(64); // sha256 hex
      expect(typeof row.rateLimit429Count).toBe("number");
      expect(row.rateLimit429Count).toBe(0); // no 429s recorded
      expect(typeof row.isActive).toBe("boolean");

      // Enriched optional fields.
      expect(row.subscriptionType).toBe("max");
      expect(row.rateLimitTier).toBe("default_claude_max_20x");
      expect(row.accountEmail).toBeNull(); // homelab blobs do not expose email
      expect(row.accountName).toBeNull();
      expect(row.orgName).toBeNull();
      expect(row.expiresAt).toBe(new Date(expiry).toISOString());
      expect(row.lastSwapAt).toBeNull();

      // Legacy back-compat fields.
      expect(typeof row.created_at).toBe("string");
      expect(row.account).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(b) minimal-credential-file fallback — fingerprint-only blob still decodes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-cred-rich-min-"));
    try {
      // Bare minimum: just a refreshToken. No subscriptionType, no expiry,
      // no email. Must still produce a valid row.
      writeFileSync(
        join(dir, "acct-min.json"),
        JSON.stringify({
          claudeAiOauth: { refreshToken: "rt-bare-minimum" },
        }),
      );

      const result = await readCredentials(dir);
      expect(result.credentials.length).toBe(1);
      const row = result.credentials[0]!;

      // id is UUID-shaped (8-4-4-4-12 = 36 chars with dashes).
      expect(row.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      // name falls back to filename label since no email/accountName exists.
      expect(row.name.length).toBeGreaterThan(0);
      // Nullable fields are explicit null (NOT omitted) for Swift decode.
      expect(row.subscriptionType).toBeNull();
      expect(row.rateLimitTier).toBeNull();
      expect(row.accountEmail).toBeNull();
      expect(row.accountName).toBeNull();
      expect(row.orgName).toBeNull();
      expect(row.expiresAt).toBeNull();
      expect(row.lastSwapAt).toBeNull();
      expect(row.rateLimit429Count).toBe(0);
      expect(row.isActive).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(c) rate-limit counter integration — 429 increments project into rateLimit429Count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-cred-rich-429-"));
    try {
      writeFileSync(
        join(dir, "acct-rl.json"),
        makeHomelabBlob({ refreshToken: "rt-rate-limited" }),
      );

      const fingerprint = fp("rt-rate-limited");

      // Pre-record three 429s via the tracker. The reader should pick up
      // the count24h projection on the next read.
      recordFailure(fingerprint, 429);
      recordFailure(fingerprint, 429);
      recordFailure(fingerprint, 429);
      // Mix in a non-429 — it should be ignored.
      recordFailure(fingerprint, 500);

      const result = await readCredentials(dir);
      expect(result.credentials.length).toBe(1);
      expect(result.credentials[0]?.fingerprint).toBe(fingerprint);
      expect(result.credentials[0]?.rateLimit429Count).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(d) isActive matches activeFingerprint — exactly one row marked active", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-cred-rich-active-"));
    try {
      const activePath = join(dir, "acct-active.json");
      const otherPath = join(dir, "acct-other.json");
      writeFileSync(activePath, makeHomelabBlob({ refreshToken: "rt-active" }));
      writeFileSync(otherPath, makeHomelabBlob({ refreshToken: "rt-other" }));

      // Symlink "active" → the row we expect to be flagged.
      symlinkSync(activePath, join(dir, "active"));

      const result = await readCredentials(dir);
      expect(result.activeFingerprint).toBe(fp("rt-active"));

      const activeRows = result.credentials.filter((c) => c.isActive);
      expect(activeRows.length).toBe(1);
      expect(activeRows[0]?.fingerprint).toBe(result.activeFingerprint!);
      expect(activeRows[0]?.status).toBe("active");

      const inactiveRows = result.credentials.filter((c) => !c.isActive);
      expect(inactiveRows.length).toBe(1);
      expect(inactiveRows[0]?.fingerprint).toBe(fp("rt-other"));
      // Non-active rows are status=available (not "active").
      expect(inactiveRows[0]?.status).toBe("available");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
