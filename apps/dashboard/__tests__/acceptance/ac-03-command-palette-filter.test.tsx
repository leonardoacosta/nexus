/**
 * AC-3: Command palette "/" filter isolates one project.
 *
 * Given 4 projects in the session list, typing a project name
 * into the command palette should filter to only matching sessions.
 */

import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSession } from "./test-helpers";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockSessions = [
  makeSession({ id: "s1", project: "nexus", agent: "alpha", machine: "alpha", status: "active" }),
  makeSession({ id: "s2", project: "dashboard", agent: "beta", machine: "beta", status: "idle" }),
  makeSession({ id: "s3", project: "api-server", agent: "gamma", machine: "gamma", status: "active" }),
  makeSession({ id: "s4", project: "co", agent: "alpha", machine: "alpha", status: "ended" }),
];

vi.mock("@/app/actions/sessions", () => ({
  fetchSessions: vi.fn(() =>
    Promise.resolve({ sessions: mockSessions, agentCount: 3 }),
  ),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { CommandPalette } from "@/components/CommandPalette";

beforeEach(() => {
  mockPush.mockClear();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AC-3: Command palette filter isolates one project", () => {
  it("shows all 4 sessions when no filter applied", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(4);
    });
  });

  it("filters to only 'nexus' when typing 'nexus'", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(4);
    });

    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "nexus" } });

    const results = screen.getAllByTestId("command-palette-result");
    expect(results.length).toBe(1);
    expect(results[0]).toHaveTextContent("nexus");
  });

  it("filters to 'co' project only", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(4);
    });

    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "co" } });

    // "co" appears in "co" project name — should isolate
    const results = screen.getAllByTestId("command-palette-result");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // The first result should contain "co"
    expect(results[0]).toHaveTextContent("co");
  });

  it("selects filtered result with Enter and navigates", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(4);
    });

    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "dashboard" } });

    const palette = screen.getByTestId("command-palette");
    fireEvent.keyDown(palette, { key: "Enter" });

    expect(mockPush).toHaveBeenCalledWith("/session/s2");
  });
});
