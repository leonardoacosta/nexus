import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ProjectGroup } from "../ProjectGroup";
import type { Session } from "@nexus/core";
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

function makeSession(overrides: Partial<WithAgent<Session>> = {}): WithAgent<Session> {
  return {
    id: "sess-1",
    pid: 1234,
    project: "nexus",
    projectId: null,
    machine: "dev-server",
    cwd: "/home/user/dev/nexus",
    branch: "main",
    startedAt: new Date(Date.now() - 3600_000),
    lastHeartbeat: new Date(Date.now() - 60_000),
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

describe("ProjectGroup", () => {
  it("renders group name and session counts", () => {
    const sessions = [
      makeSession({ id: "s1", status: "active" }),
      makeSession({ id: "s2", status: "idle" }),
    ];
    render(<ProjectGroup projectName="nexus" sessions={sessions} />);
    const names = screen.getAllByText("nexus");
    expect(names.length).toBeGreaterThanOrEqual(1);
    const counts = screen.getAllByText(/1 active.*2 total/);
    expect(counts.length).toBeGreaterThanOrEqual(1);
  });

  it("collapses and expands on click", () => {
    const sessions = [makeSession({ id: "s1" })];
    const { container } = render(
      <ProjectGroup projectName="nexus" sessions={sessions} />,
    );

    // Use the first rendered instance for scoped queries
    const root = container.firstElementChild as HTMLElement;
    const scoped = within(root);

    // Sessions visible by default
    expect(scoped.queryAllByRole("link").length).toBeGreaterThanOrEqual(1);

    // Click to collapse
    const button = scoped.getAllByRole("button")[0]!;
    fireEvent.click(button);
    expect(scoped.queryAllByRole("link").length).toBe(0);

    // Click to expand
    fireEvent.click(button);
    expect(scoped.queryAllByRole("link").length).toBeGreaterThanOrEqual(1);
  });
});
