import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ProjectsPoller } from "../ProjectsPoller";
import type { DiscoveredProject } from "@nexus/core";
import type { WithAgent } from "@/lib/agent-client";

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

const makeDiscoveredProject = (name: string, path: string): WithAgent<DiscoveredProject> => ({
  name,
  path,
  active_sessions: 0,
  total_sessions: 0,
  agent: "homelab",
});

describe("AC-15: Projects Discovered Page", () => {
  it("renders discovered projects even when no sessions are active", () => {
    const projects = [
      makeDiscoveredProject("nx", "/home/user/dev/nx"),
      makeDiscoveredProject("oo", "/home/user/dev/oo"),
    ];

    render(<ProjectsPoller initialProjects={projects} />);

    expect(screen.getByText("nx")).toBeInTheDocument();
    expect(screen.getByText("oo")).toBeInTheDocument();
  });

  it("shows a configured empty state when no projects are found", () => {
    render(<ProjectsPoller initialProjects={[]} />);

    expect(screen.getByText(/NEXUS_PROJECTS_DIR/)).toBeInTheDocument();
  });

  it("shows zero active sessions on project cards", () => {
    const projects = [makeDiscoveredProject("nx", "/home/user/dev/nx")];
    render(<ProjectsPoller initialProjects={projects} />);

    const activeLabels = screen.getAllByText("0 active");
    expect(activeLabels.length).toBeGreaterThanOrEqual(1);
  });
});
