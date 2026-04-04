/**
 * AC-2: Empty state renders when 0 sessions, N agents.
 *
 * Given 3 configured agents but 0 active sessions,
 * the dashboard should display an empty state message.
 */

import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/app/actions/sessions", () => ({
  fetchSessions: vi.fn(() =>
    Promise.resolve({ sessions: [], agentCount: 3 }),
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

import { SessionListPoller } from "@/components/SessionListPoller";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AC-2: Empty state when 0 sessions, 3 agents", () => {
  it("renders empty state message", () => {
    render(
      <SessionListPoller initialSessions={[]} initialAgentCount={3} />,
    );

    expect(screen.getByText("No active sessions")).toBeInTheDocument();
  });

  it("mentions the number of connected machines", () => {
    render(
      <SessionListPoller initialSessions={[]} initialAgentCount={3} />,
    );

    expect(
      screen.getByText("No active sessions across 3 machines"),
    ).toBeInTheDocument();
  });

  it("uses singular form for 1 machine", () => {
    render(
      <SessionListPoller initialSessions={[]} initialAgentCount={1} />,
    );

    expect(
      screen.getByText("No active sessions across 1 machine"),
    ).toBeInTheDocument();
  });

  it("does not render any session cards", () => {
    render(
      <SessionListPoller initialSessions={[]} initialAgentCount={3} />,
    );

    expect(screen.queryAllByRole("link").length).toBe(0);
  });
});
