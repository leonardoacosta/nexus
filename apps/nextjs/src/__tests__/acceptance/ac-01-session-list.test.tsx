/**
 * AC-1: Session list renders sessions from multiple agents.
 *
 * Given 3 agents each reporting sessions (5 total),
 * the SessionListPoller should render all sessions grouped by project.
 */

import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeMultiAgentSessions } from "./test-helpers";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSessions = makeMultiAgentSessions();

vi.mock("@/app/actions/sessions", () => ({
  fetchSessions: vi.fn(() =>
    Promise.resolve({ sessions: mockSessions, agentCount: 3 }),
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

describe("AC-1: Session list renders sessions from multiple agents", () => {
  it("renders all 5 sessions from 3 agents", () => {
    render(
      <SessionListPoller
        initialSessions={mockSessions}
        initialAgentCount={3}
      />,
    );

    // Should have 5 session cards (links to session detail)
    const links = screen.getAllByRole("link");
    expect(links.length).toBe(5);
  });

  it("groups sessions by project", () => {
    render(
      <SessionListPoller
        initialSessions={mockSessions}
        initialAgentCount={3}
      />,
    );

    // "nexus" project has 2 sessions, "dashboard" has 1, "api-server" has 1, "co" has 1
    // The project group headers should be visible (use getAllByText since
    // project name appears in both the group header and session cards)
    const nexusTexts = screen.getAllByText("nexus");
    expect(nexusTexts.length).toBeGreaterThanOrEqual(1);

    const dashboardTexts = screen.getAllByText("dashboard");
    expect(dashboardTexts.length).toBeGreaterThanOrEqual(1);

    const apiTexts = screen.getAllByText("api-server");
    expect(apiTexts.length).toBeGreaterThanOrEqual(1);

    const coTexts = screen.getAllByText("co");
    expect(coTexts.length).toBeGreaterThanOrEqual(1);
  });

  it("shows agent badges from different machines", () => {
    render(
      <SessionListPoller
        initialSessions={mockSessions}
        initialAgentCount={3}
      />,
    );

    // Each session card shows its agent name as a badge
    const alphas = screen.getAllByText("alpha");
    expect(alphas.length).toBeGreaterThanOrEqual(2); // 2 sessions on alpha

    const betas = screen.getAllByText("beta");
    expect(betas.length).toBeGreaterThanOrEqual(1);

    const gammas = screen.getAllByText("gamma");
    expect(gammas.length).toBeGreaterThanOrEqual(2);
  });

  it("shows status indicators for each session", () => {
    render(
      <SessionListPoller
        initialSessions={mockSessions}
        initialAgentCount={3}
      />,
    );

    const statusDots = screen.getAllByRole("status");
    expect(statusDots.length).toBeGreaterThanOrEqual(5);
  });
});
