/**
 * AC: GET /api/projects — canonical project merge.
 *
 * Tests the fetchProjects() server action which implements the same query +
 * merge logic as the GET /api/projects route. Verified behaviours:
 *
 * 1. Returns merged locations + session counts in correct order
 *    (active DESC, then name ASC).
 * 2. A project with two locations (homelab primary, mac secondary) returns
 *    both locations in the array.
 * 3. Empty table returns empty array.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// DB mock — must be hoisted before the module under test is imported.
// We expose a mutable `_rows` ref so each test can set the query result.
// ---------------------------------------------------------------------------

let _rows: unknown[] = [];

const mockChain = {
  select: vi.fn(),
  from: vi.fn(),
  leftJoin: vi.fn(),
  where: vi.fn(),
  then: vi.fn(),
};

// Make the chain fully fluent — every method returns the same chain object.
mockChain.select.mockReturnValue(mockChain);
mockChain.from.mockReturnValue(mockChain);
mockChain.leftJoin.mockReturnValue(mockChain);
// where() is the terminal call — return a real Promise so await works.
mockChain.where.mockImplementation(() => Promise.resolve(_rows));

const mockDb = { select: mockChain.select };

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => mockDb),
}));

// @nexus/db exports are only used as column references passed to the mock
// query builder, so we just need stable object identities.
vi.mock("@nexus/db", async () => {
  const actual = await vi.importActual<typeof import("@nexus/db")>("@nexus/db");
  return {
    ...actual,
    // Tables are used only as query builder arguments — identity doesn't matter.
    projects: { id: "projects.id", name: "projects.name", status: "projects.status", primaryAgentId: "projects.primaryAgentId", discoveredAt: "projects.discoveredAt" },
    projectLocations: { id: "pl.id", agentId: "pl.agentId", path: "pl.path", status: "pl.status", activeSessions: "pl.activeSessions", totalSessions: "pl.totalSessions", priority: "pl.priority", projectId: "pl.projectId" },
    agents: { id: "agents.id", name: "agents.name" },
    eq: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

import { fetchProjects } from "@/app/actions/projects";

// ---------------------------------------------------------------------------
// Row builder helpers
// ---------------------------------------------------------------------------

interface RowOverrides {
  projectId?: string;
  projectName?: string;
  primaryAgentId?: string;
  discoveredAt?: string;
  locationId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  path?: string | null;
  status?: string | null;
  activeSessions?: number | null;
  totalSessions?: number | null;
  priority?: number | null;
}

function makeRow(overrides: RowOverrides = {}) {
  return {
    projectId: overrides.projectId ?? "proj-1",
    projectName: overrides.projectName ?? "alpha",
    primaryAgentId: overrides.primaryAgentId ?? "agent-homelab",
    discoveredAt: overrides.discoveredAt ?? "2026-01-01T00:00:00.000Z",
    locationId: overrides.locationId !== undefined ? overrides.locationId : "loc-1",
    agentId: overrides.agentId !== undefined ? overrides.agentId : "agent-homelab",
    agentName: overrides.agentName !== undefined ? overrides.agentName : "homelab",
    path: overrides.path !== undefined ? overrides.path : "/home/user/dev/alpha",
    status: overrides.status ?? "active",
    activeSessions: overrides.activeSessions ?? 0,
    totalSessions: overrides.totalSessions ?? 0,
    priority: overrides.priority ?? 1,
  };
}

// ---------------------------------------------------------------------------
// Reset before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  _rows = [];
  mockChain.where.mockImplementation(() => Promise.resolve(_rows));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchProjects() — canonical merge", () => {
  describe("ordering: active DESC, name ASC", () => {
    it("places the project with more active sessions first", async () => {
      _rows = [
        makeRow({ projectId: "p-1", projectName: "zeta", activeSessions: 1, totalSessions: 3 }),
        makeRow({ projectId: "p-2", projectName: "alpha", activeSessions: 5, totalSessions: 10 }),
      ];

      const { projects } = await fetchProjects();

      expect(projects).toHaveLength(2);
      expect(projects[0].name).toBe("alpha"); // 5 active — first
      expect(projects[1].name).toBe("zeta");  // 1 active — second
    });

    it("breaks active-session ties alphabetically (name ASC)", async () => {
      _rows = [
        makeRow({ projectId: "p-1", projectName: "nexus", activeSessions: 2, totalSessions: 4 }),
        makeRow({ projectId: "p-2", projectName: "core",  activeSessions: 2, totalSessions: 6 }),
        makeRow({ projectId: "p-3", projectName: "api",   activeSessions: 2, totalSessions: 2 }),
      ];

      const { projects } = await fetchProjects();

      expect(projects.map((p) => p.name)).toEqual(["api", "core", "nexus"]);
    });

    it("returns a single project correctly ordered", async () => {
      _rows = [makeRow({ projectId: "p-1", projectName: "solo", activeSessions: 3, totalSessions: 7 })];

      const { projects } = await fetchProjects();

      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe("solo");
      expect(projects[0].activeSessions).toBe(3);
      expect(projects[0].totalSessions).toBe(7);
    });
  });

  describe("location merging", () => {
    it("returns both locations when a project appears on two agents", async () => {
      const discoveredAt = "2026-03-01T00:00:00.000Z";
      _rows = [
        // Homelab (primary)
        makeRow({
          projectId: "p-multi",
          projectName: "webapp",
          primaryAgentId: "agent-homelab",
          discoveredAt,
          locationId: "loc-hl",
          agentId: "agent-homelab",
          agentName: "homelab",
          path: "/home/leo/dev/webapp",
          status: "active",
          activeSessions: 2,
          totalSessions: 5,
          priority: 1,
        }),
        // Mac (secondary)
        makeRow({
          projectId: "p-multi",
          projectName: "webapp",
          primaryAgentId: "agent-homelab",
          discoveredAt,
          locationId: "loc-mac",
          agentId: "agent-mac",
          agentName: "mac",
          path: "/Users/leo/dev/webapp",
          status: "active",
          activeSessions: 1,
          totalSessions: 2,
          priority: 999,
        }),
      ];

      const { projects } = await fetchProjects();

      expect(projects).toHaveLength(1);
      const project = projects[0];

      expect(project.name).toBe("webapp");
      expect(project.locations).toHaveLength(2);

      const homelab = project.locations.find((l) => l.agentId === "agent-homelab");
      const mac = project.locations.find((l) => l.agentId === "agent-mac");

      expect(homelab).toBeDefined();
      expect(homelab?.isPrimary).toBe(true);
      expect(homelab?.agentName).toBe("homelab");
      expect(homelab?.path).toBe("/home/leo/dev/webapp");
      expect(homelab?.activeSessions).toBe(2);

      expect(mac).toBeDefined();
      expect(mac?.isPrimary).toBe(false);
      expect(mac?.agentName).toBe("mac");
      expect(mac?.path).toBe("/Users/leo/dev/webapp");
      expect(mac?.activeSessions).toBe(1);
    });

    it("aggregates session counts across both locations", async () => {
      const discoveredAt = "2026-03-01T00:00:00.000Z";
      _rows = [
        makeRow({
          projectId: "p-agg",
          projectName: "shared-proj",
          primaryAgentId: "agent-homelab",
          discoveredAt,
          locationId: "loc-1",
          agentId: "agent-homelab",
          agentName: "homelab",
          activeSessions: 3,
          totalSessions: 8,
          priority: 1,
        }),
        makeRow({
          projectId: "p-agg",
          projectName: "shared-proj",
          primaryAgentId: "agent-homelab",
          discoveredAt,
          locationId: "loc-2",
          agentId: "agent-mac",
          agentName: "mac",
          activeSessions: 2,
          totalSessions: 4,
          priority: 999,
        }),
      ];

      const { projects } = await fetchProjects();

      expect(projects).toHaveLength(1);
      expect(projects[0].activeSessions).toBe(5);  // 3 + 2
      expect(projects[0].totalSessions).toBe(12);  // 8 + 4
    });

    it("marks only the primary agent location as isPrimary", async () => {
      const discoveredAt = "2026-03-01T00:00:00.000Z";
      _rows = [
        makeRow({
          projectId: "p-prim",
          projectName: "tools",
          primaryAgentId: "agent-A",
          discoveredAt,
          locationId: "loc-a",
          agentId: "agent-A",
          agentName: "Agent A",
          activeSessions: 1,
          totalSessions: 1,
          priority: 1,
        }),
        makeRow({
          projectId: "p-prim",
          projectName: "tools",
          primaryAgentId: "agent-A",
          discoveredAt,
          locationId: "loc-b",
          agentId: "agent-B",
          agentName: "Agent B",
          activeSessions: 0,
          totalSessions: 0,
          priority: 999,
        }),
      ];

      const { projects } = await fetchProjects();
      const project = projects[0];

      const primary = project.locations.find((l) => l.isPrimary);
      const secondary = project.locations.find((l) => !l.isPrimary);

      expect(primary?.agentId).toBe("agent-A");
      expect(secondary?.agentId).toBe("agent-B");
    });
  });

  describe("empty table", () => {
    it("returns an empty array when no rows exist", async () => {
      _rows = [];

      const { projects } = await fetchProjects();

      expect(projects).toEqual([]);
    });
  });

  describe("null / missing location rows", () => {
    it("skips rows where locationId is null (project with no locations yet)", async () => {
      _rows = [
        makeRow({
          projectId: "p-no-loc",
          projectName: "orphan",
          locationId: null,
          agentId: null,
          agentName: null,
          path: null,
          activeSessions: null,
          totalSessions: null,
          priority: null,
        }),
      ];

      const { projects } = await fetchProjects();

      // Project is still returned, but with no locations and 0 counts
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe("orphan");
      expect(projects[0].locations).toHaveLength(0);
      expect(projects[0].activeSessions).toBe(0);
      expect(projects[0].totalSessions).toBe(0);
    });
  });
});
