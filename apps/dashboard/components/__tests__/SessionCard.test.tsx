import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SessionCard } from "../SessionCard";
import type { Session } from "@nexus/core";
import type { WithAgent } from "@/lib/agent-client";

// Mock next/link to render a plain anchor
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

function makeSession(overrides: Partial<WithAgent<Session>> = {}): WithAgent<Session> {
  return {
    id: "sess-1",
    pid: 1234,
    project: "nexus",
    machine: "dev-server",
    cwd: "/home/user/dev/nexus",
    branch: "main",
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    lastHeartbeat: new Date(Date.now() - 60_000).toISOString(),
    endedAt: null,
    status: "active",
    spec: null,
    command: null,
    agent: "dev-server",
    tmuxSession: null,
    ccSessionId: null,
    tmuxTarget: null,
    rateLimitUtilization: null,
    rateLimitType: null,
    totalCostUsd: null,
    model: null,
    sessionType: "ad_hoc",
    ...overrides,
  };
}

describe("SessionCard", () => {
  it("renders project name and agent badge", () => {
    render(<SessionCard session={makeSession()} />);
    const projects = screen.getAllByText("nexus");
    expect(projects.length).toBeGreaterThanOrEqual(1);
    const agents = screen.getAllByText("dev-server");
    expect(agents.length).toBeGreaterThanOrEqual(1);
  });

  it("shows 'No project' when project is null", () => {
    render(<SessionCard session={makeSession({ project: null })} />);
    const noProject = screen.getAllByText("No project");
    expect(noProject.length).toBeGreaterThanOrEqual(1);
  });

  it("renders status text", () => {
    render(<SessionCard session={makeSession({ status: "idle" })} />);
    const statuses = screen.getAllByText("idle");
    expect(statuses.length).toBeGreaterThanOrEqual(1);
  });

  it("links to session detail page", () => {
    // Use a unique session ID to find the correct link
    render(<SessionCard session={makeSession({ id: "unique-test-id" })} />);
    const links = screen.getAllByRole("link");
    const matchingLinks = links.filter(
      (l) => l.getAttribute("href") === "/session/unique-test-id",
    );
    expect(matchingLinks.length).toBeGreaterThanOrEqual(1);
  });

  it("renders a StatusDot", () => {
    render(<SessionCard session={makeSession({ status: "active" })} />);
    const statusDots = screen.getAllByRole("status");
    expect(statusDots.length).toBeGreaterThanOrEqual(1);
    expect(statusDots[0]).toHaveAttribute("aria-label", "active");
  });
});
