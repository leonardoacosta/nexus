/**
 * Git working-tree snapshot for a project's cwd. Surfaced by
 * `GET /projects` as `git_metadata` so the Projects-tab accordion
 * (`projects-tab-accordion-deeplink`) can render branch chips +
 * ahead/behind/dirty without each client re-shelling out to git.
 *
 * The agent resolves this via `getGitMetadata(cwd)` with a 30s per-cwd
 * cache. Non-git cwds, broken repos, or subprocess timeouts surface as
 * `git_metadata: null` (the outer field is set, the value is null).
 */
export interface GitCommit {
  author: string;
  /** ISO-8601 timestamp string. */
  ts: string;
}

export interface GitMetadata {
  /** `null` for detached HEAD. */
  branch: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  last_commit: GitCommit | null;
}

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
  /**
   * Git metadata for the project's cwd. Optional so older agents (pre-
   * `projects-tab-accordion-deeplink`) decode unchanged; explicit `null`
   * means the cwd is non-git, the subprocess failed, or the project has
   * no registered location on this agent.
   */
  git_metadata?: GitMetadata | null;
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
  /**
   * Canonical registry id (`projects.id`) for this project, or `null` when no
   * registry row exists yet (`close-registry-id-propagation-gap`). Optional so
   * older agents that omit the field still decode.
   */
  registryId?: string | null;
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
