import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock xterm.js
// ---------------------------------------------------------------------------

const mockTerminal = {
  open: vi.fn(),
  write: vi.fn(),
  dispose: vi.fn(),
  loadAddon: vi.fn(),
  onData: vi.fn(),
  onBinary: vi.fn(),
  cols: 80,
  rows: 24,
};

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(function () { return mockTerminal; }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function () { return { fit: vi.fn(), dispose: vi.fn() }; }),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function () { return { onContextLoss: vi.fn(), dispose: vi.fn() }; }),
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

interface MockWS {
  url: string;
  binaryType: string;
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let mockWsInstances: MockWS[] = [];

class MockWebSocket implements MockWS {
  url: string;
  binaryType = "blob";
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  static OPEN = 1;
  static CLOSED = 3;

  constructor(url: string) {
    this.url = url;
    mockWsInstances.push(this);
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockWsInstances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("ResizeObserver", vi.fn(function () {
    return { observe: vi.fn(), disconnect: vi.fn() };
  }));
  vi.useFakeTimers();

  mockTerminal.open.mockReset();
  mockTerminal.write.mockReset();
  mockTerminal.dispose.mockReset();
  mockTerminal.loadAddon.mockReset();
  mockTerminal.onData.mockReset();
  mockTerminal.onBinary.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { TerminalPanel } from "../TerminalPanel";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TerminalPanel", () => {
  it("renders with toolbar and terminal", async () => {
    render(<TerminalPanel agentHost="127.0.0.1:7400" sessionId="sess-1" />);

    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();
    expect(screen.getByTestId("interactive-toggle")).toBeInTheDocument();
    expect(screen.getByText("Terminal")).toBeInTheDocument();
  });

  it("defaults to stream mode", () => {
    render(<TerminalPanel agentHost="127.0.0.1:7400" sessionId="sess-1" />);

    expect(screen.getByTestId("mode-indicator")).toHaveTextContent(
      "Streaming (read-only)",
    );
  });

  it("switches mode when toggle is clicked", async () => {
    render(<TerminalPanel agentHost="127.0.0.1:7400" sessionId="sess-1" />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Click to switch to interactive
    fireEvent.click(screen.getByTestId("mode-toggle-btn"));

    expect(screen.getByTestId("mode-indicator")).toHaveTextContent("Interactive");
  });

  it("shows session ended overlay on control frame", async () => {
    render(<TerminalPanel agentHost="127.0.0.1:7400" sessionId="sess-1" />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const ws = mockWsInstances[mockWsInstances.length - 1]!;
    act(() => {
      ws.readyState = 1;
      ws.onopen?.(new Event("open"));
    });

    // Send session_ended
    act(() => {
      ws.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "session_ended" }),
        }),
      );
    });

    expect(screen.getByTestId("terminal-overlay")).toBeInTheDocument();
    expect(screen.getByText("Session ended")).toBeInTheDocument();
  });

  it("shows agent offline overlay on control frame", async () => {
    render(<TerminalPanel agentHost="127.0.0.1:7400" sessionId="sess-1" />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const ws = mockWsInstances[mockWsInstances.length - 1]!;
    act(() => {
      ws.readyState = 1;
      ws.onopen?.(new Event("open"));
    });

    act(() => {
      ws.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "agent_offline" }),
        }),
      );
    });

    expect(screen.getByTestId("terminal-overlay")).toBeInTheDocument();
    expect(screen.getByText("Machine offline")).toBeInTheDocument();
  });

  it("clears overlay when mode is switched", async () => {
    render(<TerminalPanel agentHost="127.0.0.1:7400" sessionId="sess-1" />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const ws = mockWsInstances[mockWsInstances.length - 1]!;
    act(() => {
      ws.readyState = 1;
      ws.onopen?.(new Event("open"));
    });

    // Trigger overlay
    act(() => {
      ws.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "session_ended" }),
        }),
      );
    });

    expect(screen.getByTestId("terminal-overlay")).toBeInTheDocument();

    // Switch mode — should clear overlay
    fireEvent.click(screen.getByTestId("mode-toggle-btn"));

    expect(screen.queryByTestId("terminal-overlay")).not.toBeInTheDocument();
  });

  it("shows disconnect button only in interactive mode", async () => {
    render(<TerminalPanel agentHost="127.0.0.1:7400" sessionId="sess-1" />);

    expect(screen.queryByTestId("disconnect-btn")).not.toBeInTheDocument();

    // Switch to interactive
    fireEvent.click(screen.getByTestId("mode-toggle-btn"));

    expect(screen.getByTestId("disconnect-btn")).toBeInTheDocument();
  });

  it("disconnect button reverts to stream mode", async () => {
    render(<TerminalPanel agentHost="127.0.0.1:7400" sessionId="sess-1" />);

    // Switch to interactive
    fireEvent.click(screen.getByTestId("mode-toggle-btn"));
    expect(screen.getByTestId("mode-indicator")).toHaveTextContent("Interactive");

    // Click disconnect
    fireEvent.click(screen.getByTestId("disconnect-btn"));
    expect(screen.getByTestId("mode-indicator")).toHaveTextContent(
      "Streaming (read-only)",
    );
  });
});
