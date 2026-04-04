import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ProjectCard } from "../ProjectCard";
import type { DiscoveredProject } from "@nexus/core";

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

function makeProject(overrides: Partial<DiscoveredProject> = {}): DiscoveredProject {
  return {
    name: "nexus",
    path: "/home/user/dev/nexus",
    active_sessions: 3,
    total_sessions: 7,
    agent: "dev-server",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("ProjectCard", () => {
  it("renders project name", () => {
    render(<ProjectCard project={makeProject()} />);
    const names = screen.getAllByText("nexus");
    expect(names.length).toBeGreaterThanOrEqual(1);
  });

  it("renders session count badges", () => {
    render(<ProjectCard project={makeProject()} />);
    const active = screen.getAllByText("3 active");
    expect(active.length).toBeGreaterThanOrEqual(1);
    const total = screen.getAllByText("7 total");
    expect(total.length).toBeGreaterThanOrEqual(1);
  });

  it("renders Start Session button", () => {
    render(<ProjectCard project={makeProject()} />);
    expect(screen.getByRole("button", { name: "Start Session" })).toBeDefined();
  });

  it("links to project detail page", () => {
    render(<ProjectCard project={makeProject({ name: "my-app" })} />);
    const links = screen.getAllByRole("link");
    const matchingLinks = links.filter(
      (l) => l.getAttribute("href") === "/projects/my-app",
    );
    expect(matchingLinks.length).toBeGreaterThanOrEqual(1);
  });
});
