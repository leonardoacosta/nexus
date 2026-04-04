/**
 * AC-14: Session card links to session detail.
 *
 * Verifies that clicking a session card from any view
 * navigates to the session detail page.
 */

import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeSession } from "./test-helpers";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

import { SessionCard } from "@/components/SessionCard";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AC-14: Session card links to session detail", () => {
  it("renders as a link to /session/{id}", () => {
    render(
      <SessionCard
        session={makeSession({ id: "sess-unique-42", project: "co" })}
      />,
    );

    const links = screen.getAllByRole("link");
    const matchingLink = links.find(
      (l) => l.getAttribute("href") === "/session/sess-unique-42",
    );
    expect(matchingLink).toBeDefined();
  });

  it("displays project name in the card", () => {
    render(
      <SessionCard
        session={makeSession({ id: "sess-1", project: "co" })}
      />,
    );

    const projects = screen.getAllByText("co");
    expect(projects.length).toBeGreaterThanOrEqual(1);
  });

  it("displays agent badge", () => {
    render(
      <SessionCard
        session={makeSession({
          id: "sess-1",
          project: "co",
          agent: "alpha",
        })}
      />,
    );

    const agents = screen.getAllByText("alpha");
    expect(agents.length).toBeGreaterThanOrEqual(1);
  });

  it("displays status indicator", () => {
    render(
      <SessionCard
        session={makeSession({
          id: "sess-1",
          project: "co",
          status: "active",
        })}
      />,
    );

    const statusDots = screen.getAllByRole("status");
    expect(statusDots.length).toBeGreaterThanOrEqual(1);
    expect(statusDots[0]).toHaveAttribute("aria-label", "active");
  });

  it("links work for sessions from different agents", () => {
    const { rerender } = render(
      <SessionCard
        session={makeSession({
          id: "sess-alpha-1",
          agent: "alpha",
          project: "co",
        })}
      />,
    );

    let links = screen.getAllByRole("link");
    expect(
      links.some((l) => l.getAttribute("href") === "/session/sess-alpha-1"),
    ).toBe(true);

    rerender(
      <SessionCard
        session={makeSession({
          id: "sess-beta-1",
          agent: "beta",
          project: "co",
        })}
      />,
    );

    links = screen.getAllByRole("link");
    expect(
      links.some((l) => l.getAttribute("href") === "/session/sess-beta-1"),
    ).toBe(true);
  });
});
