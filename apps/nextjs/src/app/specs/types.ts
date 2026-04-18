/**
 * Wire types for the `/specs/all` agent endpoint. Mirrors the shape used
 * by the server-rendered page and the client-side refetch in the live
 * updates subscriber.
 */

export interface SpecSnapshot {
  name: string;
  status: string;
  completed_tasks: number;
  total_tasks: number;
  last_modified: string | null;
}

export interface BeadsSummary {
  open: number;
  closed: number;
  ready: number;
}

export interface ProjectSpecStatus {
  code: string;
  name: string;
  specs: SpecSnapshot[];
  beads: BeadsSummary | null;
}

export interface AllSpecsResponse {
  projects: ProjectSpecStatus[];
}
