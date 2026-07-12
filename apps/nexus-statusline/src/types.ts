export interface CcInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string; git_worktree?: string };
  version?: string;
  output_style?: { name?: string };
  effort?: { level?: string };
  exceeds_200k_tokens?: boolean;
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  context_window?: {
    used_percentage?: number;
    context_window_size?: number;
  };
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
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

export type { UsagePeriod, UsageResponse, CachedUsage } from "@nexus/statusline-contract";
