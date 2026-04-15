/**
 * Domain-level Session types for the Nexus application layer.
 *
 * These types use JSON-friendly representations (string timestamps, string
 * literal unions for enums) that match the REST/JSON transport between the
 * Bun agent and Next.js dashboard.
 */

/** A Claude Code session running on a specific machine. */
export interface Session {
  id: string;
  pid: number;
  /**
   * Human-readable project name, typically derived from a join on `projects.id`.
   * Undefined when no join has been performed (raw row-to-session mapping).
   * Consumers needing the canonical identifier should prefer `projectId`.
   */
  project?: string | null;
  /** Canonical FK to `projects.id` (uuid). Nullable — sessions without a registered project. */
  projectId: string | null;
  machine: string | null;
  cwd: string;
  branch: string | null;
  startedAt: Date;
  lastHeartbeat: Date;
  endedAt: Date | null;
  status: SessionStatus;
  spec: string | null;
  command: string | null;
  agent: string | null;
  tmuxSession: string | null;
  ccSessionId: string | null;
  tmuxTarget: string | null;

  // Telemetry fields
  rateLimitUtilization: number | null;
  rateLimitType: string | null;
  totalCostUsd: number | null;
  model: string | null;

  // Credential binding (best-effort, populated from session_start events)
  /** FK to credentials.id — NULL when credential binding is unavailable. */
  credentialId: string | null;
  /** SHA-256 fingerprint of the credential's refresh token — denormalized for aggregation. */
  credentialFingerprint: string | null;

  sessionType: SessionType;
}

export type SessionStatus = "active" | "idle" | "ended" | "stale" | "errored";

export type SessionType = "ad_hoc" | "managed" | "pooled";
