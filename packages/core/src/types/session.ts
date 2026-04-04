/** A Claude Code session running on a specific machine. */
export interface Session {
  id: string;
  pid: number;
  project: string | null;
  machine: string;
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
