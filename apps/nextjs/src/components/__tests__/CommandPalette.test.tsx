import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CommandPalette } from "../CommandPalette";
import type { Session } from "@nexus/core";
import type { WithAgent } from "@/lib/agent-client";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
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

const mockSessions: WithAgent<Session>[] = [
  makeSession({ id: "s1", project: "nexus", machine: "alpha", agent: "alpha", status: "active" }),
  makeSession({ id: "s2", project: "dashboard", machine: "beta", agent: "beta", status: "idle" }),
  makeSession({ id: "s3", project: "api-server", machine: "gamma", agent: "gamma", status: "ended" }),
];

vi.mock("@/app/actions/sessions", () => ({
  fetchSessions: vi.fn(() =>
    Promise.resolve({ sessions: mockSessions, agentCount: 3 }),
  ),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CommandPalette", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render when closed", () => {
    render(<CommandPalette isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
  });

  it("renders overlay and input when open", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByTestId("command-palette")).toBeInTheDocument();
    expect(screen.getByTestId("command-palette-input")).toBeInTheDocument();
  });

  it("shows sessions after loading", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(3);
    });
  });

  // -- Fuzzy search --

  it("filters sessions by project name", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(3);
    });

    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "nexus" } });

    const results = screen.getAllByTestId("command-palette-result");
    expect(results.length).toBe(1);
    expect(results[0]).toHaveTextContent("nexus");
  });

  it("filters sessions by machine hostname", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(3);
    });

    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "beta" } });

    const results = screen.getAllByTestId("command-palette-result");
    expect(results.length).toBe(1);
    expect(results[0]).toHaveTextContent("dashboard");
  });

  it("filters sessions by status", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(3);
    });

    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "idle" } });

    const results = screen.getAllByTestId("command-palette-result");
    expect(results.length).toBe(1);
    expect(results[0]).toHaveTextContent("dashboard");
  });

  it("is case-insensitive", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(3);
    });

    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "NEXUS" } });

    expect(screen.getAllByTestId("command-palette-result").length).toBe(1);
  });

  it("shows empty state when no match", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(3);
    });

    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "zzzznotexist" } });

    expect(screen.queryAllByTestId("command-palette-result").length).toBe(0);
    expect(screen.getByText("No sessions match your search")).toBeInTheDocument();
  });

  // -- Keyboard navigation --

  it("navigates results with ArrowDown and ArrowUp", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(3);
    });

    const palette = screen.getByTestId("command-palette");

    // First item should be selected by default
    const results = screen.getAllByTestId("command-palette-result");
    expect(results[0]).toHaveAttribute("aria-selected", "true");

    // ArrowDown moves to second item
    fireEvent.keyDown(palette, { key: "ArrowDown" });
    const updatedResults = screen.getAllByTestId("command-palette-result");
    expect(updatedResults[1]).toHaveAttribute("aria-selected", "true");
    expect(updatedResults[0]).toHaveAttribute("aria-selected", "false");

    // ArrowUp moves back to first
    fireEvent.keyDown(palette, { key: "ArrowUp" });
    const afterUp = screen.getAllByTestId("command-palette-result");
    expect(afterUp[0]).toHaveAttribute("aria-selected", "true");
  });

  it("wraps around at boundaries", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(3);
    });

    const palette = screen.getByTestId("command-palette");

    // ArrowUp from first wraps to last
    fireEvent.keyDown(palette, { key: "ArrowUp" });
    const results = screen.getAllByTestId("command-palette-result");
    expect(results[2]).toHaveAttribute("aria-selected", "true");

    // ArrowDown from last wraps to first
    fireEvent.keyDown(palette, { key: "ArrowDown" });
    const after = screen.getAllByTestId("command-palette-result");
    expect(after[0]).toHaveAttribute("aria-selected", "true");
  });

  it("selects session with Enter and navigates", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(3);
    });

    const palette = screen.getByTestId("command-palette");
    fireEvent.keyDown(palette, { key: "Enter" });

    expect(mockPush).toHaveBeenCalledWith("/session/s1");
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen={true} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByTestId("command-palette")).toBeInTheDocument();
    });

    const palette = screen.getByTestId("command-palette");
    fireEvent.keyDown(palette, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when clicking the backdrop", async () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen={true} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByTestId("command-palette-backdrop")).toBeInTheDocument();
    });

    const backdrop = screen.getByTestId("command-palette-backdrop");
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when clicking inside the palette", async () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen={true} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByTestId("command-palette")).toBeInTheDocument();
    });

    const palette = screen.getByTestId("command-palette");
    fireEvent.click(palette);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("navigates on click of a result item", async () => {
    render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(3);
    });

    const results = screen.getAllByTestId("command-palette-result");
    fireEvent.click(results[1]!);

    expect(mockPush).toHaveBeenCalledWith("/session/s2");
  });

  it("resets query and selection when reopened", async () => {
    const { rerender } = render(
      <CommandPalette isOpen={true} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("command-palette-result").length).toBe(3);
    });

    // Type a query
    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "nexus" } });
    expect(screen.getAllByTestId("command-palette-result").length).toBe(1);

    // Close
    rerender(<CommandPalette isOpen={false} onClose={vi.fn()} />);

    // Reopen
    rerender(<CommandPalette isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      const newInput = screen.getByTestId("command-palette-input");
      expect(newInput).toHaveValue("");
    });
  });
});
