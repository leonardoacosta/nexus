/**
 * Filesystem reader for the credential-pool service.
 *
 * Reads the agent host's Claude Code credentials and projects them into
 * the wire shape consumed by the Mac dashboard's `/credentials` view.
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

const log = createLogger("agent:credential-pool:reader");

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** Status of a credential row in the `/credentials` wire shape. */
export type CredentialStatus = "active" | "available" | "expired";

/** One row in the `/credentials` wire `credentials` array. */
export interface CredentialEntry {
  fingerprint: string;
  account: string | null;
  created_at: string;
  status: CredentialStatus;
}

/** Top-level `/credentials` response envelope. */
export interface CredentialReadResult {
  credentials: CredentialEntry[];
  activeFingerprint: string | null;
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

    rows.push({
      fingerprint,
      account: extractAccountLabel(plaintext) ?? basename(filename, ".json"),
      created_at: mtime.toISOString(),
      status: isExpired(plaintext) ? "expired" : "available",
    });
  }

  const activeFingerprint = detectActiveFingerprint(dir);

  // Mark the matching row as active. Leave "expired" rows alone — an
  // expired credential can't be "the active one" in any useful sense.
  if (activeFingerprint) {
    for (const row of rows) {
      if (row.fingerprint === activeFingerprint && row.status !== "expired") {
        row.status = "active";
      }
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
