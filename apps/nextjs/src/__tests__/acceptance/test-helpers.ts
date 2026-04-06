/**
 * Shared test helpers for acceptance tests.
 * Provides factory functions for mock data used across all AC tests.
 */

import type { Session } from "@nexus/core";
import type { WithAgent, AgentStatus } from "@/lib/agent-client";
import type { HealthMetrics } from "@nexus/core";
import type { CanonicalProject } from "@nexus/core";

export function makeSession(overrides: Partial<WithAgent<Session>> = {}): WithAgent<Session> {
  return {
    id: "sess-1",
    pid: 1234,
    project: "nexus",
    machine: "dev-server",
    cwd: "/home/user/dev/nexus",
    branch: "main",
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    lastHeartbeat: new Date(Date.now() - 60_000).toISOString(),
    endedAt: null,
    status: "active",
    spec: null,
    command: null,
    agent: "dev-server",
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

export function makeAgentStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    name: "dev-server",
    online: true,
    lastSeen: new Date(),
    ...overrides,
  };
}

export function makeHealthMetrics(
  overrides: Partial<WithAgent<HealthMetrics>> = {},
): WithAgent<HealthMetrics> {
  return {
    hostname: "dev-server",
    uptime_seconds: 86400,
    cpu: {
      overall_percent: 45,
      per_core_percent: [40, 50],
      load_average: [1.5, 1.2, 0.9],
    },
    ram: {
      total_bytes: 16_000_000_000,
      used_bytes: 8_000_000_000,
      percent: 50,
    },
    disk: [
      {
        mount: "/",
        total_bytes: 500_000_000_000,
        used_bytes: 200_000_000_000,
        percent: 40,
      },
    ],
    docker: { containers: 5, running: 3 },
    agent: "dev-server",
    ...overrides,
  };
}

interface MakeProjectOptions {
  name?: string;
  path?: string;
  active_sessions?: number;
  total_sessions?: number;
  agent?: string;
}

export function makeProject(overrides: MakeProjectOptions = {}): CanonicalProject {
  const agentId = overrides.agent ?? "dev-server";
  const name = overrides.name ?? "nexus";
  const path = overrides.path ?? "/home/user/dev/nexus";
  const activeSessions = overrides.active_sessions ?? 2;
  const totalSessions = overrides.total_sessions ?? 5;

  return {
    id: `project-${name}`,
    name,
    primaryAgentId: agentId,
    locations: [
      {
        agentId,
        agentName: agentId,
        path,
        activeSessions,
        totalSessions,
        isPrimary: true,
        status: "active",
        priority: 1,
      },
    ],
    activeSessions,
    totalSessions,
    discoveredAt: new Date().toISOString(),
  };
}

/**
 * Create a set of mock sessions distributed across multiple agents.
 * Used for AC-1 and similar multi-agent scenarios.
 */
export function makeMultiAgentSessions(): WithAgent<Session>[] {
  return [
    makeSession({ id: "s1", project: "nexus", agent: "alpha", machine: "alpha", status: "active" }),
    makeSession({ id: "s2", project: "dashboard", agent: "alpha", machine: "alpha", status: "idle" }),
    makeSession({ id: "s3", project: "api-server", agent: "beta", machine: "beta", status: "active" }),
    makeSession({ id: "s4", project: "nexus", agent: "gamma", machine: "gamma", status: "ended" }),
    makeSession({ id: "s5", project: "co", agent: "gamma", machine: "gamma", status: "active" }),
  ];
}

/**
 * Create multi-agent statuses for health tests.
 */
export function makeMultiAgentStatuses(): AgentStatus[] {
  return [
    makeAgentStatus({ name: "alpha", online: true }),
    makeAgentStatus({ name: "beta", online: true }),
    makeAgentStatus({ name: "gamma", online: true }),
  ];
}
