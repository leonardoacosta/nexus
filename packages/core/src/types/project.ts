export interface Project {
  /**
   * Registry project UUID (matches `projects.id`, the path-param
   * `PATCH /projects/:id` validates against). `null` for session-only
   * fallback buckets (e.g. `(unregistered)`) that have no registry row —
   * the UI hides the remove affordance on id-less rows. Optional so older
   * agents that omit the field still decode.
   */
  id?: string | null;
  name: string;
  active_sessions: number;
  total_sessions: number;
  machines: string[];
  /**
   * Sticky-exclude flag from `projects.hidden` (`folder-based-project-autodiscovery`).
   * Non-optional in current-generation agent emissions so the Swift dashboard can
   * filter hidden projects from the list view without round-tripping through
   * `PATCH /projects/:id`. Synthetic `(unregistered)` buckets emit `false`.
   *
   * Older agents (pre-`agent-payload-completeness`) omit this field — the
   * Swift decoder substitutes `false` for backward tolerance.
   */
  hidden: boolean;
}

export interface DiscoveredProject {
  name: string;
  path: string;
  active_sessions: number;
  total_sessions: number;
  /** Agent name this project was discovered from (set by client, not agent) */
  agent: string;
  /** Number of agents that reported this same project (populated after dedup) */
  machineCount?: number;
  /** Git remote URL for origin; stable cross-machine identity key. Optional — old agents omit it. */
  gitRemoteUrl?: string | null;
}

/** Response wrapper from GET /projects/discovered */
export interface DiscoveredProjectsResponse {
  projects: DiscoveredProject[];
  truncated: boolean;
}

/** A per-machine location entry for a canonical project. */
export interface ProjectLocation {
  agentId: string;
  agentName: string;
  path: string;
  activeSessions: number;
  totalSessions: number;
  isPrimary: boolean;
  /** 'active' = found in last scan, 'missing' = not found, 'archived' = manually removed */
  status: "active" | "missing" | "archived";
  /** Sort priority — 1 for primary agent, 999 for others */
  priority: number;
}

/** A canonical project with aggregated location data across all agents. */
export interface CanonicalProject {
  id: string;
  name: string;
  primaryAgentId: string;
  locations: ProjectLocation[];
  activeSessions: number;
  totalSessions: number;
  /** Timestamp of first discovery */
  discoveredAt: Date | string;
  tags: string[] | null;
  description: string | null;
}
