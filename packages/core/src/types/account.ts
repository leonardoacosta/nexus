/**
 * Account-first credential model types.
 *
 * The credentials page renders one row per **Account** — an Anthropic
 * identity, deduplicated by OAuth refresh-token fingerprint. Each account
 * bundles the per-file snapshots that all share the same refresh token
 * (because the user has copied the same credential into multiple slots)
 * along with subscription/usage metadata.
 *
 * These types are JSON-friendly: timestamps are ISO-8601 strings, not
 * `Date` objects, so they survive the Next.js server-action serialization
 * boundary without transformation.
 */

/**
 * A single credential file observed on disk.
 *
 * Multiple `CredentialFile`s with the same `fingerprint` collapse into a
 * single `Account`. `isPrimary` identifies which file the pool prefers
 * when leasing from this account.
 */
export interface CredentialFile {
  /** Database row id (uuid). */
  id: string;
  /** Human-friendly file-derived name, e.g. `acct-1757881174456`. */
  name: string;
  /** Pool state. */
  status: string;
  /** Credential type discriminator, e.g. `oauth`. */
  type: string;
  /** SHA-256 hex of `claudeAiOauth.refreshToken`. Non-null post-backfill. */
  fingerprint: string;
  /** Opaque group id; defaults to the fingerprint. */
  duplicateGroupId: string;
  /** Whether this file is the preferred lease target within its group. */
  isPrimary: boolean;
  /** OAuth access-token expiry (ISO-8601). */
  expiresAt: string | null;
  rateLimitCount: number;
  /** Session id currently holding a lease on this file, if any. */
  leasedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 5-hour usage-window snapshot for an account, produced by the
 * Anthropic usage poller. May be null when the poller has not yet
 * observed this account.
 */
export interface UsageSnapshot {
  /** 0..100 — percent of the 5-hour window consumed. */
  percent: number;
  /** ISO-8601 instant when the rolling window resets. */
  resetsAt: string;
  /** ISO-8601 instant the snapshot was captured. */
  observedAt: string;
}

/**
 * Top-level row on the credentials page.
 *
 * Keyed by `fingerprint` — every `snapshots[i].fingerprint` equals
 * the account's fingerprint. `isActiveForCc` is true for at most one
 * account at any instant (the one whose fingerprint matches the
 * current `~/.claude/.credentials.json`).
 */
export interface Account {
  fingerprint: string;
  /** True iff this account is currently read by Claude Code on the agent host. */
  isActiveForCc: boolean;
  /** Null when the usage poller has not yet captured this account. */
  usagePercent: number | null;
  /** Null when the usage poller has not yet captured this account. */
  resetsAt: string | null;
  /** Subscription tier label ("max", "team", …) — lower-case as emitted by OAuth blob. */
  plan: string | null;
  /** Rate-limit tier raw string ("default_claude_max_20x" …). */
  tier: string | null;
  /** All files (≥1) observed on disk for this account. First element is primary. */
  snapshots: CredentialFile[];
}
