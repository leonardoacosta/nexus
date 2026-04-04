/**
 * AC-13: Projects page shows sessions across machines.
 *
 * Given project "co" with 2 sessions on 2 machines,
 * the Projects page should render the project card correctly.
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
        makeProject({
          name: "co",
          active_sessions: 2,
          total_sessions: 4,
          machines: ["alpha", "beta"],
          agent: "alpha",
        }),
        makeProject({
          name: "nexus",
          active_sessions: 1,
          total_sessions: 3,
          machines: ["gamma"],
          agent: "gamma",
        }),
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

describe("AC-13: Project page — sessions across machines", () => {
  it("renders project cards for each project", () => {
    render(
      <ProjectsPoller
        initialProjects={[
          makeProject({
            name: "co",
            active_sessions: 2,
            total_sessions: 4,
            machines: ["alpha", "beta"],
            agent: "alpha",
          }),
          makeProject({
            name: "nexus",
            active_sessions: 1,
            total_sessions: 3,
            machines: ["gamma"],
            agent: "gamma",
          }),
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
          makeProject({
            name: "co",
            active_sessions: 2,
            total_sessions: 4,
            machines: ["alpha", "beta"],
            agent: "alpha",
          }),
        ]}
      />,
    );

    expect(screen.getByText("2 active")).toBeInTheDocument();
    expect(screen.getByText("4 total")).toBeInTheDocument();
  });

  it("shows machine badges for multi-machine project", () => {
    render(
      <ProjectsPoller
        initialProjects={[
          makeProject({
            name: "co",
            active_sessions: 2,
            total_sessions: 4,
            machines: ["alpha", "beta"],
            agent: "alpha",
          }),
        ]}
      />,
    );

    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
  });

  it("links to project detail page", () => {
    render(
      <ProjectsPoller
        initialProjects={[
          makeProject({
            name: "co",
            active_sessions: 2,
            total_sessions: 4,
            machines: ["alpha", "beta"],
            agent: "alpha",
          }),
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
