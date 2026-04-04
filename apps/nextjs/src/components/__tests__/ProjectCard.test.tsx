import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ProjectCard } from "../ProjectCard";
import type { Project } from "@nexus/core";
import type { WithAgent } from "@/lib/agent-client";

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

function makeProject(overrides: Partial<WithAgent<Project>> = {}): WithAgent<Project> {
  return {
    name: "nexus",
    active_sessions: 3,
    total_sessions: 7,
    machines: ["dev-server", "build-box"],
    agent: "dev-server",
    ...overrides,
  };
}

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

  it("renders machine badges", () => {
    render(<ProjectCard project={makeProject()} />);
    const devServers = screen.getAllByText("dev-server");
    expect(devServers.length).toBeGreaterThanOrEqual(1);
    const buildBoxes = screen.getAllByText("build-box");
    expect(buildBoxes.length).toBeGreaterThanOrEqual(1);
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
