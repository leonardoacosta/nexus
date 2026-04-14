/**
 * Shared test helpers for agent-client test files.
 */

import type { AgentConfig, Session } from "@nexus/core";

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

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
