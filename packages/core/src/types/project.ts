export interface Project {
  name: string;
  active_sessions: number;
  total_sessions: number;
  machines: string[];
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
}

/** Response wrapper from GET /projects/discovered */
export interface DiscoveredProjectsResponse {
  projects: DiscoveredProject[];
  truncated: boolean;
}
