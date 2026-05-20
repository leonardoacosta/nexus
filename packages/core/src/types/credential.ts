/**
 * Credential wire types — kept in sync with Swift `CcProfile` in
 * `apps/swift/NexusShared/Models/CcProfile.swift`.
 *
 * Spec: openspec/changes/credentials-rich-emission (task 1.6)
 *
 * Two types live here:
 *
 *  1. `Credential` — the legacy pool-state shape (lease/cooldown lifecycle).
 *     Retained for callers that consume the pool internals directly.
 *  2. `CredentialEntry` — the enriched per-row wire shape returned by
 *     `GET /credentials`. Mirrors Swift `CcProfile`. The agent's
 *     filesystem reader (`apps/agent/src/services/credential-pool/reader.ts`)
 *     and DB-pool handler both project to this shape so the dashboard
 *     sees a consistent payload regardless of which code path served the
 *     request.
 */

/** Credential pool lifecycle states. */
export type CredentialStatus = "available" | "leased" | "cooldown";

/**
 * Wire status emitted on `/credentials` rows.
 *
 * Different from `CredentialStatus` (pool lifecycle): this is the
 * dashboard-facing triage status — is the row active, available, or
 * expired? The agent maps lifecycle → wire status before emit.
 */
export type CredentialWireStatus = "active" | "available" | "expired";

/** A credential managed by the agent's credential pool (lifecycle view). */
export interface Credential {
  id: string;
  name: string;
  type: string;
  status: CredentialStatus;
  leased_by?: string;
  leased_at?: Date;
  cooldown_until?: Date;
}

/**
 * One row in the `/credentials` response. Wire-format mirror of Swift
 * `CcProfile`. Optional fields are `null` (not omitted) when the
 * credential source does not expose them — this keeps Swift's permissive
 * decoders straightforward and prevents "missing key" vs "null value"
 * ambiguity for clients in other languages.
 *
 * `expiresAt` and `lastSwapAt` are ISO-8601 strings on the wire; Swift's
 * `decodePermissiveDate` accepts both string and epoch-number forms but
 * the agent always emits ISO-8601 for human readability and consistency.
 */
export interface CredentialEntry {
  /** Stable UUID-shaped id derived from fingerprint. Required by Swift. */
  id: string;
  /** Human-readable label: email > accountName > acct-* filename > short fp. */
  name: string;
  /** SHA-256 hex of `claudeAiOauth.refreshToken`. Stable identity. */
  fingerprint: string;
  /** "free" | "pro" | "team" | "max" | string | null. */
  subscriptionType: string | null;
  /** e.g. "default_claude_max_20x". Null when unknown. */
  rateLimitTier: string | null;
  /** OAuth account email (CC doesn't expose this on disk today → null). */
  accountEmail: string | null;
  /** OAuth account display name (not exposed by CC today → null). */
  accountName: string | null;
  /** Org name when surfaced (not exposed by CC today → null). */
  orgName: string | null;
  /** Triage status — see CredentialWireStatus. */
  status: CredentialWireStatus;
  /** ISO-8601 OAuth expiry, or null. */
  expiresAt: string | null;
  /** Count of 429 responses observed for this fingerprint in trailing 24h. */
  rateLimit429Count: number;
  /** ISO-8601 of last swap event involving this fingerprint, or null. */
  lastSwapAt: string | null;
  /** True iff this row's fingerprint matches the envelope's activeFingerprint. */
  isActive: boolean;
}

/**
 * Top-level envelope for `GET /credentials`. Mirrors Swift
 * `CredentialListResponse`.
 */
export interface CredentialReadResponse {
  credentials: CredentialEntry[];
  /** The fingerprint currently active on the agent host, or null. */
  activeFingerprint: string | null;
}
