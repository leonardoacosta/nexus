/**
 * Filesystem reader for the credential-pool service.
 *
 * Reads the agent host's Claude Code credentials and projects them into
 * the wire shape consumed by the Mac dashboard's `/credentials` view.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * KEY SET (credentials-rich-emission task 1.1, 2026-05-20):
 *
 * Inspected ~/.claude/.credentials.json on Mac (not present — CC not logged
 * in here) and homelab (nyaptor@100.73.182.4). Homelab pool entries under
 * ~/.config/nexus/credentials/acct-*.json (18 files) ALL share this shape:
 *
 *   {
 *     "claudeAiOauth": {
 *       "accessToken":     "sk-ant-oat01-...",
 *       "refreshToken":    "sk-ant-ort01-...",    // <- fingerprint source
 *       "expiresAt":       1775306344008,          // epoch ms (number)
 *       "scopes":          ["user:file_upload", "user:inference", ...],
 *       "subscriptionType":"max",                  // free|pro|team|max
 *       "rateLimitTier":   "default_claude_max_20x"
 *     },
 *     "mcpOAuth": { "<provider>|<id>": { "serverName": "...", ... } }
 *   }
 *
 * Notable ABSENCES (the spec's proposal.md speculated these keys exist;
 * the actual CC file on a real host does NOT include them):
 *   - `accountUuid`     — NOT in the on-disk OAuth blob
 *   - `email`           — NOT in the on-disk OAuth blob
 *   - `displayName`     — NOT in the on-disk OAuth blob
 *   - `accountName`     — NOT in the on-disk OAuth blob
 *   - `orgName`         — NOT in the on-disk OAuth blob
 *
 * Mapping to Swift CcProfile (apps/swift/NexusShared/Models/CcProfile.swift):
 *   id                  := sha1(fingerprint).slice(0,32) as UUID-shaped hex
 *   name                := <email if ever surfaced> ?? <fingerprint[0..8]>
 *   fingerprint         := sha256(claudeAiOauth.refreshToken)   [unchanged]
 *   subscriptionType    := claudeAiOauth.subscriptionType
 *   rateLimitTier       := claudeAiOauth.rateLimitTier
 *   accountEmail        := claudeAiOauth.email ?? null   [null in practice]
 *   accountName         := claudeAiOauth.accountName ?? null   [null today]
 *   orgName             := null   [CC does not expose this on disk]
 *   status              := "active" | "available" | "expired"
 *   expiresAt           := new Date(claudeAiOauth.expiresAt).toISOString()
 *   rateLimit429Count   := rate-limit-tracker.count24h(fingerprint)
 *   lastSwapAt          := swap-tracker.lastSwapAt(fingerprint)?.toISOString()
 *   isActive            := fingerprint === envelope.activeFingerprint
 *
 * ───────────────────────────────────────────────────────────────────────────
 * INVESTIGATION (homelab-emits-specs-credentials task 1.7, 2026-05-20):
 *
 * I checked CC's active-credential convention on two hosts to learn the
 * real disk layout (rather than guessing):
 *
 *   macbook (this Mac):
 *     ~/.claude/.credentials/        — does NOT exist
 *     ~/.claude/.credentials.json    — does NOT exist (CC not logged in)
 *
 *   homelab (nyaptor@100.73.182.4):
 *     ~/.claude/.credentials/        — does NOT exist
 *     ~/.claude/.credentials.json    — exists, regular file, mode 600
 *                                       (NOT a symlink on this host)
 *     ~/.config/nexus/credentials/   — exists, contains acct-*.json files
 *                                       (the nexus *pool* storage)
 *
 * So the canonical CC convention is the SINGLE file
 * `~/.claude/.credentials.json` — NOT a directory of credentials and NOT a
 * symlink (the active-credential-watcher already handles the symlink case
 * if/when CC adds one). The earlier "spec sees a directory" wording was
 * speculative.
 *
 * This reader therefore scans the *nexus pool directory*
 * (`~/.config/nexus/credentials/`) for acct-*.json files — that's where
 * per-account credential payloads actually live on disk. The active
 * fingerprint is determined by hashing the contents of
 * `~/.claude/.credentials.json` and matching against the pool entries
 * (mirrors active-credential-watcher.ts logic, but as a one-shot read
 * suitable for cold starts before the watcher has produced a snapshot).
 *
 * Fallback chain for active-fingerprint detection:
 *   1. symlink at <dir>/active (CC convention as documented in the spec)
 *   2. <dir>/active.json marker file (alternative CC convention)
 *   3. SHA-256(claudeAiOauth.refreshToken) of ~/.claude/.credentials.json
 *      matched against an enumerated pool entry
 *   4. null (no detectable active marker)
 *
 * Test-only behaviour: callers pass an explicit `dir` so tests can use
 * a tmpdir fixture and never touch the real `$HOME`.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createLogger } from "@nexus/core/node";
import {
  computeCredentialFingerprint,
  CredentialParseError,
} from "../../credentials/credentials.helpers";
import { count24h } from "./rate-limit-tracker";
import { lastSwapAt as swapTrackerLastSwapAt } from "./swap-tracker";

const log = createLogger("agent:credential-pool:reader");

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** Status of a credential row in the `/credentials` wire shape. */
export type CredentialStatus = "active" | "available" | "expired";

/**
 * One row in the `/credentials` wire `credentials` array.
 *
 * Matches the Swift `CcProfile` Codable struct in
 * `apps/swift/NexusShared/Models/CcProfile.swift`. Field-by-field rationale
 * lives in the file-header comment block (key set discovery).
 *
 * Legacy fields retained for backward compat with existing TS consumers:
 *   - `account`     (deprecated alias of `name`; kept until call sites migrate)
 *   - `created_at`  (file mtime; not consumed by the dashboard)
 */
export interface CredentialEntry {
  /** Stable UUID derived from fingerprint. Required by Swift CcProfile. */
  id: string;
  /** Human-readable label: email if available, else short fp prefix. */
  name: string;
  /** SHA-256 of claudeAiOauth.refreshToken — stable identity. */
  fingerprint: string;
  /** CC subscription tier (free|pro|team|max). Null when absent. */
  subscriptionType: string | null;
  /** CC rate-limit tier label, e.g. "default_claude_max_20x". */
  rateLimitTier: string | null;
  /** OAuth account email (CC doesn't expose this on disk today → null). */
  accountEmail: string | null;
  /** OAuth account display name (not exposed by CC today → null). */
  accountName: string | null;
  /** Org name when surfaced (not exposed by CC today → null). */
  orgName: string | null;
  /** "active" | "available" | "expired". */
  status: CredentialStatus;
  /** ISO-8601 string of OAuth token expiry, or null. */
  expiresAt: string | null;
  /** Count of 429 responses observed for this fingerprint in trailing 24h. */
  rateLimit429Count: number;
  /** ISO-8601 string of last swap event involving this fingerprint, or null. */
  lastSwapAt: string | null;
  /** True iff this row's fingerprint matches the envelope's activeFingerprint. */
  isActive: boolean;

  // ── Legacy/back-compat fields ──────────────────────────────────────────
  /** @deprecated Alias of `name`. Retained for pre-enrichment consumers. */
  account: string | null;
  /** File mtime as ISO-8601. Not consumed by Swift; kept for ops/debug. */
  created_at: string;
}

/** Top-level `/credentials` response envelope. */
export interface CredentialReadResult {
  credentials: CredentialEntry[];
  activeFingerprint: string | null;
}

// ---------------------------------------------------------------------------
// Identity derivation
// ---------------------------------------------------------------------------

/**
 * Derive a stable, UUID-shaped id from a credential fingerprint.
 *
 * The fingerprint is already a SHA-256 hex (64 chars). We re-hash via SHA-1
 * and slice 32 hex chars, then format as 8-4-4-4-12 so the value parses as
 * a UUID for clients that want one. Pure function of the fingerprint, so
 * the same credential always yields the same id across reads + restarts.
 */
function deriveStableId(fingerprint: string): string {
  const hex = createHash("sha1").update(fingerprint).digest("hex").slice(0, 32);
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20, 32)
  );
}

/** Derive a short, human-readable name when no email is available. */
function shortFingerprintName(fingerprint: string): string {
  return `cred-${fingerprint.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Default pool credential directory. Override via reader fn arg for tests. */
export function defaultCredentialsDir(): string {
  return join(homedir(), ".config", "nexus", "credentials");
}

/** CC's per-host active credential file (single JSON, possibly a symlink). */
function ccActiveCredentialPath(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Best-effort account-label extraction from an OAuth blob. */
function extractAccountLabel(plaintext: string): string | null {
  try {
    const parsed = JSON.parse(plaintext);
    const oauth = parsed?.claudeAiOauth;
    if (typeof oauth !== "object" || oauth === null) return null;

    const email = (oauth as { email?: unknown }).email;
    if (typeof email === "string" && email.length > 0) return email;

    const accountName =
      (oauth as { accountName?: unknown }).accountName ??
      (oauth as { account_name?: unknown }).account_name;
    if (typeof accountName === "string" && accountName.length > 0) {
      return accountName;
    }

    return null;
  } catch {
    return null;
  }
}

/** Pulled from the OAuth blob — null when the file omits the key. */
interface EnrichedMetadata {
  subscriptionType: string | null;
  rateLimitTier: string | null;
  accountEmail: string | null;
  accountName: string | null;
  orgName: string | null;
  expiresAtIso: string | null;
}

/**
 * Best-effort enriched-metadata extraction. Returns all-null on parse failure
 * — the fingerprint step already validated the JSON structure, so this is
 * purely projection.
 */
function extractEnrichedMetadata(plaintext: string): EnrichedMetadata {
  const empty: EnrichedMetadata = {
    subscriptionType: null,
    rateLimitTier: null,
    accountEmail: null,
    accountName: null,
    orgName: null,
    expiresAtIso: null,
  };
  try {
    const parsed = JSON.parse(plaintext);
    const oauth = parsed?.claudeAiOauth;
    if (typeof oauth !== "object" || oauth === null) return empty;

    const subscriptionType =
      typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null;
    const rateLimitTier =
      typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : null;
    const accountEmail =
      typeof oauth.email === "string" && oauth.email.length > 0
        ? oauth.email
        : null;
    const accountName =
      typeof oauth.accountName === "string" && oauth.accountName.length > 0
        ? oauth.accountName
        : null;
    const orgName =
      typeof oauth.orgName === "string" && oauth.orgName.length > 0
        ? oauth.orgName
        : null;

    let expiresAtIso: string | null = null;
    const expiresAt = oauth.expiresAt;
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
      try {
        expiresAtIso = new Date(expiresAt).toISOString();
      } catch {
        expiresAtIso = null;
      }
    } else if (typeof expiresAt === "string") {
      const ms = Date.parse(expiresAt);
      if (!Number.isNaN(ms)) {
        expiresAtIso = new Date(ms).toISOString();
      }
    }

    return {
      subscriptionType,
      rateLimitTier,
      accountEmail,
      accountName,
      orgName,
      expiresAtIso,
    };
  } catch {
    return empty;
  }
}

/** Determine whether the OAuth expiry has passed (best-effort). */
function isExpired(plaintext: string): boolean {
  try {
    const parsed = JSON.parse(plaintext);
    const expiresAt = parsed?.claudeAiOauth?.expiresAt;
    if (typeof expiresAt !== "number" && typeof expiresAt !== "string") {
      return false;
    }
    const ms =
      typeof expiresAt === "number"
        ? expiresAt
        : Date.parse(expiresAt);
    if (Number.isNaN(ms)) return false;
    return ms < Date.now();
  } catch {
    return false;
  }
}

/**
 * Active-fingerprint detection. Tries the documented CC conventions
 * (symlink at <dir>/active, marker file <dir>/active.json) before falling
 * back to hashing `~/.claude/.credentials.json` directly.
 *
 * Returns null on all failure modes so the caller can render the dashboard
 * without "active" being inferable.
 */
function detectActiveFingerprint(dir: string): string | null {
  // 1. Symlink-style marker.
  const symlinkPath = join(dir, "active");
  if (existsSync(symlinkPath)) {
    try {
      const resolved = realpathSync(symlinkPath);
      const plaintext = readFileSync(resolved, "utf-8");
      return computeCredentialFingerprint(plaintext);
    } catch (err) {
      log.debug({ symlinkPath, error: err }, "active symlink resolution failed");
    }
  }

  // 2. Marker file containing the fingerprint or a path to the active file.
  const markerPath = join(dir, "active.json");
  if (existsSync(markerPath)) {
    try {
      const raw = readFileSync(markerPath, "utf-8").trim();
      const parsed = JSON.parse(raw);
      if (typeof parsed?.fingerprint === "string") return parsed.fingerprint;
      if (typeof parsed?.path === "string" && existsSync(parsed.path)) {
        return computeCredentialFingerprint(readFileSync(parsed.path, "utf-8"));
      }
    } catch (err) {
      log.debug({ markerPath, error: err }, "active.json marker read failed");
    }
  }

  // 3. CC's `~/.claude/.credentials.json` (single file or symlink).
  const ccPath = ccActiveCredentialPath();
  if (existsSync(ccPath)) {
    try {
      let resolved = ccPath;
      try {
        resolved = realpathSync(ccPath);
      } catch {
        // Not a symlink — read the original path.
      }
      const plaintext = readFileSync(resolved, "utf-8");
      return computeCredentialFingerprint(plaintext);
    } catch (err) {
      if (err instanceof CredentialParseError) {
        log.debug({ ccPath, error: err.message }, "CC credentials file unparseable");
      } else {
        log.debug({ ccPath, error: err }, "CC credentials file read failed");
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public reader
// ---------------------------------------------------------------------------

/**
 * Read every `acct-*.json` entry under `dir` and project to the wire shape.
 *
 * Behaviour invariants:
 *   - Returns `{credentials: [], activeFingerprint: null}` when `dir` does
 *     not exist or contains no acct-*.json files. Never throws.
 *   - Malformed JSON files are skipped (warn-logged, never rethrown).
 *   - Active fingerprint detection follows the cascade described in
 *     `detectActiveFingerprint` above; null when no matching pool entry
 *     can be tied to the active marker.
 *   - The row whose fingerprint matches `activeFingerprint` is tagged
 *     `status: "active"`. Rows whose payload `expiresAt` has passed are
 *     tagged `status: "expired"`. All others are `status: "available"`.
 */
export async function readCredentials(
  dir: string = defaultCredentialsDir(),
): Promise<CredentialReadResult> {
  if (!existsSync(dir)) {
    log.debug({ dir }, "credentials directory does not exist");
    return { credentials: [], activeFingerprint: null };
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    log.debug({ dir, error: err }, "readdir(credentials) failed");
    return { credentials: [], activeFingerprint: null };
  }

  const credentialFiles = entries.filter(
    (f) => f.startsWith("acct-") && f.endsWith(".json"),
  );

  const rows: CredentialEntry[] = [];
  for (const filename of credentialFiles) {
    const filePath = join(dir, filename);
    let plaintext: string;
    let mtime: Date;
    try {
      plaintext = readFileSync(filePath, "utf-8");
      mtime = statSync(filePath).mtime;
    } catch (err) {
      log.warn({ file: filename, error: err }, "credential file read failed");
      continue;
    }

    let fingerprint: string;
    try {
      fingerprint = computeCredentialFingerprint(plaintext);
    } catch (err) {
      if (err instanceof CredentialParseError) {
        log.warn(
          { file: filename, error: err.message },
          "credential file unparseable — skipping",
        );
        continue;
      }
      throw err;
    }

    const enriched = extractEnrichedMetadata(plaintext);
    const accountLabel =
      extractAccountLabel(plaintext) ?? basename(filename, ".json");
    const name =
      enriched.accountEmail ??
      enriched.accountName ??
      accountLabel ??
      shortFingerprintName(fingerprint);
    const lastSwap = swapTrackerLastSwapAt(fingerprint);

    rows.push({
      id: deriveStableId(fingerprint),
      name,
      fingerprint,
      subscriptionType: enriched.subscriptionType,
      rateLimitTier: enriched.rateLimitTier,
      accountEmail: enriched.accountEmail,
      accountName: enriched.accountName,
      orgName: enriched.orgName,
      status: isExpired(plaintext) ? "expired" : "available",
      expiresAt: enriched.expiresAtIso,
      rateLimit429Count: count24h(fingerprint),
      lastSwapAt: lastSwap ? lastSwap.toISOString() : null,
      // isActive is populated after activeFingerprint resolves below.
      isActive: false,
      // Legacy fields kept for back-compat.
      account: accountLabel,
      created_at: mtime.toISOString(),
    });
  }

  const activeFingerprint = detectActiveFingerprint(dir);

  // Mark the matching row as active. Leave "expired" rows alone — an
  // expired credential can't be "the active one" in any useful sense.
  if (activeFingerprint) {
    for (const row of rows) {
      if (row.fingerprint === activeFingerprint && row.status !== "expired") {
        row.status = "active";
        row.isActive = true;
      }
    }
  }

  // Final fallback (fix-credential-source-divergence task 1.2): when the
  // nexus pool directory has no acct-*.json files BUT the host has a valid
  // `~/.claude/.credentials.json`, synthesize a single entry from the
  // dotted file so the dashboard reflects the real active Claude Code
  // credential. Without this branch the endpoint returns empty on every
  // host that uses CC directly (no nexus pool import) — the original
  // symptom that motivated the spec.
  if (rows.length === 0) {
    const synthetic = readActiveCcCredentialEntry();
    if (synthetic) {
      return {
        credentials: [synthetic],
        activeFingerprint: synthetic.fingerprint,
      };
    }
  }

  return {
    credentials: rows,
    // Only return the active fingerprint if we actually found a matching
    // pool entry. Otherwise the dashboard would render "active: <unknown>"
    // which is worse than null.
    activeFingerprint:
      activeFingerprint && rows.some((r) => r.fingerprint === activeFingerprint)
        ? activeFingerprint
        : null,
  };
}

/**
 * Read `~/.claude/.credentials.json` and project it into a single
 * `CredentialEntry`. Returns null when the file is absent or unparseable.
 *
 * Mirrors `active-credential-watcher.ts`' realpath handling so a symlinked
 * credentials file (Claude Code rotates via symlink swap on some hosts)
 * resolves to its target before reading. This is the synthesis path used
 * by `readCredentials()` when the nexus pool is empty — see the call site
 * for rationale.
 */
function readActiveCcCredentialEntry(): CredentialEntry | null {
  const ccPath = ccActiveCredentialPath();
  if (!existsSync(ccPath)) return null;

  let resolvedPath = ccPath;
  try {
    resolvedPath = realpathSync(ccPath);
  } catch {
    // Not a symlink, or link target missing — fall back to the original
    // path so a regular file is still read correctly.
    resolvedPath = ccPath;
  }

  let plaintext: string;
  let mtime: Date;
  try {
    plaintext = readFileSync(resolvedPath, "utf-8");
    mtime = statSync(resolvedPath).mtime;
  } catch (err) {
    log.debug({ ccPath, resolvedPath, error: err }, "active CC credentials read failed");
    return null;
  }

  let fingerprint: string;
  try {
    fingerprint = computeCredentialFingerprint(plaintext);
  } catch (err) {
    if (err instanceof CredentialParseError) {
      log.debug({ resolvedPath, error: err.message }, "active CC credentials unparseable");
      return null;
    }
    throw err;
  }

  const enriched = extractEnrichedMetadata(plaintext);
  const accountLabel = extractAccountLabel(plaintext) ?? "claude-code-active";
  const name =
    enriched.accountEmail ??
    enriched.accountName ??
    accountLabel ??
    shortFingerprintName(fingerprint);
  const lastSwap = swapTrackerLastSwapAt(fingerprint);
  const expired = isExpired(plaintext);

  return {
    id: deriveStableId(fingerprint),
    name,
    fingerprint,
    subscriptionType: enriched.subscriptionType,
    rateLimitTier: enriched.rateLimitTier,
    accountEmail: enriched.accountEmail,
    accountName: enriched.accountName,
    orgName: enriched.orgName,
    status: expired ? "expired" : "active",
    expiresAt: enriched.expiresAtIso,
    rateLimit429Count: count24h(fingerprint),
    lastSwapAt: lastSwap ? lastSwap.toISOString() : null,
    isActive: !expired,
    // Legacy fields kept for back-compat.
    account: accountLabel,
    created_at: mtime.toISOString(),
  };
}
