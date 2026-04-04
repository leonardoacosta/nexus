/**
 * AC-9: Resize event forwarding.
 *
 * Verifies that terminal resize events are sent as JSON
 * control frames over the WebSocket in interact mode.
 */

import { render, act, cleanup } from "@testing-library/react";
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

import { XTerminal } from "@/components/XTerminal";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AC-9: Resize event forwarding", () => {
  it("sends initial resize frame on connect in interact mode", async () => {
    render(
      <XTerminal
        agentHost="127.0.0.1:7400"
        sessionId="sess-1"
        mode="interact"
      />,
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const ws = mockWsInstances[mockWsInstances.length - 1]!;
    act(() => {
      ws.readyState = 1;
      ws.onopen?.(new Event("open"));
    });

    // Initial resize should be sent with cols=80, rows=24 (mock defaults)
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
    );
  });

  it("does not send resize in stream mode", async () => {
    render(
      <XTerminal
        agentHost="127.0.0.1:7400"
        sessionId="sess-1"
        mode="stream"
      />,
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const ws = mockWsInstances[mockWsInstances.length - 1]!;
    act(() => {
      ws.readyState = 1;
      ws.onopen?.(new Event("open"));
    });

    // No resize should be sent in stream mode
    const resizeCalls = ws.send.mock.calls.filter((call: unknown[]) => {
      const arg = call[0];
      if (typeof arg === "string") {
        try {
          const parsed = JSON.parse(arg);
          return parsed.type === "resize";
        } catch {
          return false;
        }
      }
      return false;
    });

    expect(resizeCalls.length).toBe(0);
  });

  it("sends resize with correct dimensions", async () => {
    // Override terminal dimensions
    mockTerminal.cols = 120;
    mockTerminal.rows = 40;

    render(
      <XTerminal
        agentHost="127.0.0.1:7400"
        sessionId="sess-1"
        mode="interact"
      />,
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const ws = mockWsInstances[mockWsInstances.length - 1]!;
    act(() => {
      ws.readyState = 1;
      ws.onopen?.(new Event("open"));
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "resize", cols: 120, rows: 40 }),
    );

    // Reset
    mockTerminal.cols = 80;
    mockTerminal.rows = 24;
  });
});
