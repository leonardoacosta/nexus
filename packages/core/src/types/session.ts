/**
 * Domain-level Session types for the Nexus application layer.
 *
 * These types use JSON-friendly representations (string timestamps, string
 * literal unions for enums) that match the REST/JSON transport between the
 * Bun agent and Next.js dashboard.
 *
 * The canonical schema lives in `proto/nexus.proto`. Wire-format generated
 * types are available from `@nexus/core/generated/nexus` for gRPC consumers.
 */

// Re-export proto-generated Session type for gRPC / wire-format consumers.
export type { Session as ProtoSession } from "../generated/nexus";

/** A Claude Code session running on a specific machine. */
export interface Session {
  id: string;
  pid: number;
  project: string | null;
  machine: string | null;
  cwd: string;
  branch: string | null;
  startedAt: string;
  lastHeartbeat: string;
  endedAt: string | null;
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

  sessionType: SessionType;
}

export type SessionStatus = "active" | "idle" | "ended" | "stale" | "errored";

export type SessionType = "ad_hoc" | "managed" | "pooled";
