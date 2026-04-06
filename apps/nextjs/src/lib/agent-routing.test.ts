import { describe, it, expect } from "vitest";
import { resolveAttachAgent, getPrimaryAgentName } from "./agent-routing";
import type { CanonicalProject } from "@nexus/core";
import type { AgentStatus } from "./agent-client";

// Helper to build a minimal CanonicalProject
function makeProject(overrides: Partial<CanonicalProject> = {}): CanonicalProject {
  return {
    id: "test-id",
    name: "nx",
    primaryAgentId: "homelab",
    locations: [
      {
        agentId: "homelab",
        agentName: "homelab",
        path: "/home/leo/dev/nx",
        activeSessions: 0,
        totalSessions: 0,
        isPrimary: true,
        status: "active",
        priority: 1,
      },
      {
        agentId: "mac",
        agentName: "mac",
        path: "/Users/leo/dev/nx",
        activeSessions: 0,
        totalSessions: 0,
        isPrimary: false,
        status: "active",
        priority: 999,
      },
    ],
    activeSessions: 0,
    totalSessions: 0,
    discoveredAt: new Date().toISOString(),
    ...overrides,
  };
}

const homelabOnline: AgentStatus = { name: "homelab", online: true, lastSeen: new Date() };
const macOnline: AgentStatus = { name: "mac", online: true, lastSeen: new Date() };
const homelabOffline: AgentStatus = { name: "homelab", online: false, lastSeen: null };

describe("resolveAttachAgent", () => {
  it("primary online → routes to homelab, isFallback=false", () => {
    const project = makeProject();
    const result = resolveAttachAgent(project, [homelabOnline, macOnline]);
    expect(result).toEqual({ agentId: "homelab", isFallback: false });
  });

  it("primary missing → routes to mac, isFallback=true", () => {
    const project = makeProject({
      locations: [
        {
          agentId: "homelab",
          agentName: "homelab",
          path: "/home/leo/dev/nx",
          activeSessions: 0,
          totalSessions: 0,
          isPrimary: true,
          status: "missing",
          priority: 1,
        },
        {
          agentId: "mac",
          agentName: "mac",
          path: "/Users/leo/dev/nx",
          activeSessions: 0,
          totalSessions: 0,
          isPrimary: false,
          status: "active",
          priority: 999,
        },
      ],
    });
    const result = resolveAttachAgent(project, [homelabOnline, macOnline]);
    expect(result).toEqual({ agentId: "mac", isFallback: true });
  });

  it("primary offline (agent down) → routes to mac, isFallback=true", () => {
    const project = makeProject();
    const result = resolveAttachAgent(project, [homelabOffline, macOnline]);
    expect(result).toEqual({ agentId: "mac", isFallback: true });
  });

  it("no agents online → last resort primary, isFallback=true", () => {
    const project = makeProject();
    const result = resolveAttachAgent(project, []);
    expect(result).toEqual({ agentId: "homelab", isFallback: true });
  });
});

describe("getPrimaryAgentName", () => {
  it("returns 'homelab' for the test project", () => {
    const project = makeProject();
    expect(getPrimaryAgentName(project)).toBe("homelab");
  });
});
