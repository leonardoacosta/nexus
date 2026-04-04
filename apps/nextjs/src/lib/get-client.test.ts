import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentClient } from "./agent-client";

// ---------------------------------------------------------------------------
// Mock ./db module
// ---------------------------------------------------------------------------

const mockWhere = vi.fn();
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockDb = { select: mockSelect };

vi.mock("./db", () => ({
  getDb: vi.fn(() => mockDb),
}));

// Mock @nexus/db to provide agents table and eq helper
vi.mock("@nexus/db", () => ({
  agents: { enabled: "enabled" },
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are registered
// ---------------------------------------------------------------------------

const { getAgentConfigs, getClient, getAgentHost } = await import("./get-client");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AgentRow = {
  id: string;
  name: string;
  host: string;
  port: number;
  enabled: boolean;
  projectsDir: string;
  lastSeen: null;
  createdAt: null;
};

function makeRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "server1",
    name: "server1",
    host: "100.1.2.3",
    port: 7400,
    enabled: true,
    projectsDir: "",
    lastSeen: null,
    createdAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getAgentConfigs", () => {
  beforeEach(() => {
    mockWhere.mockReset();
    mockFrom.mockClear();
    mockSelect.mockClear();
  });

  it("returns mapped configs for rows returned from DB", async () => {
    const rows: AgentRow[] = [
      makeRow({ id: "server1", name: "server1", host: "100.1.2.3", port: 7400 }),
      makeRow({ id: "server2", name: "", host: "100.1.2.4", port: 7401 }),
    ];
    mockWhere.mockResolvedValue(rows);

    const configs = await getAgentConfigs();

    expect(configs).toHaveLength(2);
    expect(configs[0]!.name).toBe("server1");
    expect(configs[0]!.host).toBe("100.1.2.3");
    expect(configs[0]!.port).toBe(7400);
    // empty name falls back to id
    expect(configs[1]!.name).toBe("server2");
    expect(configs[1]!.host).toBe("100.1.2.4");
    expect(configs[1]!.port).toBe(7401);
  });

  it("returns localhost fallback when DB is empty", async () => {
    mockWhere.mockResolvedValue([]);

    const configs = await getAgentConfigs();

    expect(configs).toEqual([{ name: "localhost", host: "127.0.0.1", port: 7400 }]);
  });

  it("uses port 7400 as default when row.port is null", async () => {
    const rows = [makeRow({ port: null as unknown as number })];
    mockWhere.mockResolvedValue(rows);

    const configs = await getAgentConfigs();

    expect(configs[0]!.port).toBe(7400);
  });
});

describe("getClient", () => {
  beforeEach(() => {
    mockWhere.mockReset();
  });

  it("returns an AgentClient instance backed by DB configs", async () => {
    mockWhere.mockResolvedValue([
      makeRow({ id: "srv", name: "srv", host: "10.0.0.1", port: 7400 }),
    ]);

    const client = await getClient();

    expect(client).toBeInstanceOf(AgentClient);
  });
});

describe("getAgentHost", () => {
  beforeEach(() => {
    mockWhere.mockReset();
  });

  it("returns host:port string for a known agent name", async () => {
    mockWhere.mockResolvedValue([
      makeRow({ id: "alpha", name: "alpha", host: "10.0.1.1", port: 7400 }),
    ]);

    const result = await getAgentHost("alpha");

    expect(result).toBe("10.0.1.1:7400");
  });

  it("returns null for an unknown agent name", async () => {
    mockWhere.mockResolvedValue([
      makeRow({ id: "alpha", name: "alpha", host: "10.0.1.1", port: 7400 }),
    ]);

    const result = await getAgentHost("nonexistent");

    expect(result).toBeNull();
  });

  it("returns null when DB is empty (localhost fallback does not match)", async () => {
    mockWhere.mockResolvedValue([]);

    const result = await getAgentHost("nonexistent");

    expect(result).toBeNull();
  });
});
