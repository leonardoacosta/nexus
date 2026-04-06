import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ProjectCard } from "../ProjectCard";
import type { CanonicalProject } from "@nexus/core";

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

// Mock startSession server action — must use vi.hoisted so the reference is
// available when vi.mock is hoisted to the top of the file by vitest.
const { mockStartSession } = vi.hoisted(() => ({
  mockStartSession: vi.fn(),
}));

vi.mock("@/app/actions/settings", () => ({
  startSession: mockStartSession,
}));

const makeProject = (): CanonicalProject => ({
  id: "project-nx",
  name: "nx",
  primaryAgentId: "homelab",
  locations: [
    {
      agentId: "homelab",
      agentName: "homelab",
      path: "/home/user/dev/nx",
      activeSessions: 0,
      totalSessions: 0,
      isPrimary: true,
      status: "active",
      priority: 1,
    },
  ],
  activeSessions: 0,
  totalSessions: 0,
  discoveredAt: new Date().toISOString(),
});

describe("AC-16: Start Session Button", () => {
  afterEach(() => {
    cleanup();
    mockStartSession.mockReset();
  });

  it("shows a Start Session button on the project card", () => {
    render(<ProjectCard project={makeProject()} />);
    expect(
      screen.getByRole("button", { name: /start session/i }),
    ).toBeInTheDocument();
  });

  it("shows optimistic Starting… state when button is clicked", async () => {
    // Make startSession take long enough to check the intermediate state
    mockStartSession.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 100)),
    );

    render(<ProjectCard project={makeProject()} />);
    const button = screen.getByRole("button", { name: /start session/i });

    fireEvent.click(button);

    // Button should immediately show "Starting…" and be disabled
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /starting/i })).toBeDisabled();
    });
  });

  it("shows error when startSession fails", async () => {
    mockStartSession.mockRejectedValueOnce(
      new Error("tmux not found — install tmux on this agent"),
    );

    render(<ProjectCard project={makeProject()} />);
    const button = screen.getByRole("button", { name: /start session/i });

    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText(/tmux not found/i)).toBeInTheDocument();
    });
  });
});
