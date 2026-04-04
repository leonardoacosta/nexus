import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { AgentManagementPanel } from "../AgentManagementPanel";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/app/actions/settings", () => ({
  saveAgentConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockAgents = [
  {
    name: "homelab",
    host: "homelab",
    port: 7400,
    role: "agent",
    projects_dir: "/home/user/dev",
  },
  {
    name: "macbook",
    host: "macbook",
    port: 7400,
    role: "agent",
    projects_dir: "/Users/user/dev",
  },
];

const mockStatuses = [
  { name: "homelab", online: true, lastSeen: new Date() },
  { name: "macbook", online: false, lastSeen: null },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AC-17: Agent Management Panel", () => {
  it("renders the list of configured agents", () => {
    render(
      <AgentManagementPanel
        initialAgents={mockAgents}
        agentStatuses={mockStatuses}
      />,
    );

    // Both name and host columns render the same value for these agents — use getAllByText
    expect(screen.getAllByText("homelab").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("macbook").length).toBeGreaterThanOrEqual(1);
  });

  it("shows online/offline status for agents", () => {
    render(
      <AgentManagementPanel
        initialAgents={mockAgents}
        agentStatuses={mockStatuses}
      />,
    );

    // Badge renders "Online" for homelab and "Offline" for macbook
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("renders an Add Agent form with name and host inputs", () => {
    render(
      <AgentManagementPanel
        initialAgents={mockAgents}
        agentStatuses={mockStatuses}
      />,
    );

    // Name input placeholder is "my-dev-machine"; host placeholder contains "hostname"
    expect(
      screen.getByPlaceholderText("my-dev-machine"),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/hostname/i),
    ).toBeInTheDocument();
  });

  it("shows agent frontmatter fields (port, projects_dir)", () => {
    render(
      <AgentManagementPanel
        initialAgents={mockAgents}
        agentStatuses={mockStatuses}
      />,
    );

    // Port column — both agents share 7400, rendered as text in table cells
    const portCells = screen.getAllByText("7400");
    // At least one cell in the agent table (the form default also uses "7400" as input value)
    expect(portCells.length).toBeGreaterThanOrEqual(1);

    // Projects dir for the first agent
    expect(screen.getByText("/home/user/dev")).toBeInTheDocument();
  });

  it("renders Remove buttons for each agent", () => {
    render(
      <AgentManagementPanel
        initialAgents={mockAgents}
        agentStatuses={mockStatuses}
      />,
    );

    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    expect(removeButtons).toHaveLength(mockAgents.length);
  });

  it("renders Save button in add form", () => {
    render(
      <AgentManagementPanel
        initialAgents={mockAgents}
        agentStatuses={mockStatuses}
      />,
    );

    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });
});
