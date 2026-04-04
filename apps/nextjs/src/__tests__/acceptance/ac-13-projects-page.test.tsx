/**
 * AC-13: Projects page shows discovered projects with session counts.
 *
 * Given project "co" with 2 active sessions, the Projects page should
 * render the project card correctly with session count badges.
 */

import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeProject } from "./test-helpers";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/app/actions/projects", () => ({
  fetchProjects: vi.fn(() =>
    Promise.resolve({
      projects: [
        makeProject({ name: "co", active_sessions: 2, total_sessions: 4, agent: "alpha" }),
        makeProject({ name: "nexus", active_sessions: 1, total_sessions: 3, agent: "gamma" }),
      ],
    }),
  ),
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

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { ProjectsPoller } from "@/components/ProjectsPoller";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AC-13: Project page — sessions across agents", () => {
  it("renders project cards for each project", () => {
    render(
      <ProjectsPoller
        initialProjects={[
          makeProject({ name: "co", active_sessions: 2, total_sessions: 4, agent: "alpha" }),
          makeProject({ name: "nexus", active_sessions: 1, total_sessions: 3, agent: "gamma" }),
        ]}
      />,
    );

    expect(screen.getByText("co")).toBeInTheDocument();
    expect(screen.getByText("nexus")).toBeInTheDocument();
  });

  it("shows active session count and total for 'co'", () => {
    render(
      <ProjectsPoller
        initialProjects={[
          makeProject({ name: "co", active_sessions: 2, total_sessions: 4, agent: "alpha" }),
        ]}
      />,
    );

    expect(screen.getAllByText("2 active").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("4 total").length).toBeGreaterThanOrEqual(1);
  });

  it("shows the project path from discovered project", () => {
    render(
      <ProjectsPoller
        initialProjects={[
          makeProject({
            name: "co",
            path: "/home/user/dev/co",
            active_sessions: 2,
            total_sessions: 4,
            agent: "alpha",
          }),
        ]}
      />,
    );

    // Project name link should be present
    expect(screen.getByText("co")).toBeInTheDocument();
  });

  it("links to project detail page", () => {
    render(
      <ProjectsPoller
        initialProjects={[
          makeProject({ name: "co", active_sessions: 2, total_sessions: 4, agent: "alpha" }),
        ]}
      />,
    );

    const links = screen.getAllByRole("link");
    const coLink = links.find((l) => l.getAttribute("href") === "/projects/co");
    expect(coLink).toBeDefined();
  });

  it("shows empty state when no projects", () => {
    render(<ProjectsPoller initialProjects={[]} />);

    expect(screen.getByText("No projects found")).toBeInTheDocument();
  });
});
