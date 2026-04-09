import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ProjectsPoller } from "../ProjectsPoller";
import type { CanonicalProject } from "@nexus/core";

// Mock the fetchProjects action — not called on initial render
vi.mock("@/app/actions/projects", () => ({
  fetchProjects: vi.fn().mockResolvedValue({ projects: [] }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/app/actions/settings", () => ({
  startSession: vi.fn().mockResolvedValue({ session_name: "test", started: true }),
}));

function makeCanonicalProject(name: string, path: string): CanonicalProject {
  return {
    id: `project-${name}`,
    name,
    primaryAgentId: "homelab",
    locations: [
      {
        agentId: "homelab",
        agentName: "homelab",
        path,
        activeSessions: 0,
        totalSessions: 0,
        isPrimary: true,
        status: "active",
        priority: 1,
      },
    ],
    activeSessions: 0,
    totalSessions: 0,
    discoveredAt: new Date(),
    tags: null,
    description: null,
  };
}

describe("AC-15: Projects Discovered Page", () => {
  it("renders discovered projects even when no sessions are active", () => {
    const projects = [
      makeCanonicalProject("nx", "/home/user/dev/nx"),
      makeCanonicalProject("oo", "/home/user/dev/oo"),
    ];

    render(<ProjectsPoller initialProjects={projects} />);

    expect(screen.getByText("nx")).toBeInTheDocument();
    expect(screen.getByText("oo")).toBeInTheDocument();
  });

  it("shows a configured empty state when no projects are found", () => {
    render(<ProjectsPoller initialProjects={[]} />);

    // ProjectsPoller empty state renders "No projects in registry"
    expect(screen.getByText(/No projects in registry/)).toBeInTheDocument();
  });

  it("shows zero active sessions on project cards", () => {
    const projects = [makeCanonicalProject("nx", "/home/user/dev/nx")];
    render(<ProjectsPoller initialProjects={projects} />);

    // ProjectsTable renders bare numeric cells in the Active column
    const activeCells = screen.getAllByRole("cell").filter(
      (cell) => cell.textContent === "0",
    );
    expect(activeCells.length).toBeGreaterThanOrEqual(1);
  });
});
