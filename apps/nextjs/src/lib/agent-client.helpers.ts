/**
 * Shared test helpers for agent-client test files.
 */

import type { AgentConfig, Session, HealthMetrics, Project } from "@nexus/core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const agents: AgentConfig[] = [
  { name: "dev-1", host: "100.64.0.1", port: 7400 },
  { name: "dev-2", host: "100.64.0.2", port: 7400 },
  { name: "offline", host: "100.64.0.99", port: 7400 },
];

export function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    pid: 1234,
    project: "nx",
    projectId: null,
    machine: "dev-1",
    cwd: "/home/user/dev/nx",
    branch: "main",
    startedAt: new Date("2026-04-03T10:00:00Z"),
    lastHeartbeat: new Date("2026-04-03T10:05:00Z"),
    endedAt: null,
    status: "active",
    spec: null,
    command: null,
    agent: null,
    tmuxSession: null,
    ccSessionId: null,
    tmuxTarget: null,
    rateLimitUtilization: null,
    rateLimitType: null,
    totalCostUsd: null,
    model: null,
    sessionType: "ad_hoc",
    ...overrides,
  };
}

export function makeHealth(hostname: string): HealthMetrics {
  return {
    hostname,
    uptime_seconds: 86400,
    cpu: { overall_percent: 25, per_core_percent: [25], load_average: [1.0] },
    ram: { total_bytes: 16e9, used_bytes: 8e9, percent: 50 },
    disk: [{ mount: "/", total_bytes: 500e9, used_bytes: 200e9, percent: 40 }],
    docker: null,
  };
}

export function makeProject(name: string): Project {
  return { name, active_sessions: 1, total_sessions: 5, machines: ["dev-1"] };
}

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
