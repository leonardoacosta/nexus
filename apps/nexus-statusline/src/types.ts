export interface CcInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string; git_worktree?: string };
  version?: string;
  effort?: { level?: string };
  cost?: {
    total_duration_ms?: number;
    total_api_duration_ms?: number;
  };
  // KEPT despite the proposal's removal list naming `context_window`:
  // context-guard.ts's `resolveContext` (explicitly left as-is, task 1.4)
  // reads `ccInput.context_window` directly to feed the still-live
  // nx-agent context-push snapshot — removing this field would break that
  // unrelated, unchanged requirement. See engineer report for this batch.
  context_window?: {
    used_percentage?: number;
    context_window_size?: number;
  };
}

export interface StatuslineSession {
  id: string;
  project: string | null;
  status: string;
  model: string | null;
  cwd: string | null;
  idle_seconds: number;
}

export interface StatuslineResponse {
  sessions: StatuslineSession[];
  git: { branch: string; dirty: boolean; ahead: number; behind: number } | null;
  machine: { cpu_percent: number; mem_percent: number; load_1m: number };
  uptime_seconds: number;
  daemon_count: number;
}

export interface GitInfo {
  branch: string;
  dirty: boolean;
  ahead: number;
}

/** Context value resolved by the guard for rendering (null = omit segment). */
export interface ResolvedContext {
  usedPct: number;
  contextWindowSize?: number;
}

export type { UsagePeriod, UsageResponse, CachedUsage } from "@nexus/statusline-contract";
