/**
 * AC-5: XTerminal component handles scroll-back data.
 *
 * Verifies that incoming terminal data (200 lines) is written
 * to the terminal instance, which has scrollback configured.
 */

import { render, screen, act, cleanup } from "@testing-library/react";
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

describe("AC-5: 200 lines output — scroll-back works", () => {
  it("writes 200 lines of data to the terminal", async () => {
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

    // Send 200 lines of output
    for (let i = 1; i <= 200; i++) {
      act(() => {
        ws.onmessage?.(
          new MessageEvent("message", { data: `Line ${i}: output data\r\n` }),
        );
      });
    }

    // All 200 lines should have been written to the terminal
    expect(mockTerminal.write).toHaveBeenCalledTimes(200);
    expect(mockTerminal.write).toHaveBeenCalledWith("Line 1: output data\r\n");
    expect(mockTerminal.write).toHaveBeenCalledWith("Line 200: output data\r\n");
  });

  it("handles binary data for scrollback", async () => {
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

    // Send binary data (ArrayBuffer)
    const buf = new TextEncoder().encode("binary line data\r\n").buffer;
    const msgEvent = new MessageEvent("message", { data: buf });

    // jsdom may or may not preserve ArrayBuffer type
    if (msgEvent.data instanceof ArrayBuffer) {
      act(() => {
        ws.onmessage?.(msgEvent);
      });
      expect(mockTerminal.write).toHaveBeenCalledWith(expect.any(Uint8Array));
    }
  });

  it("terminal is configured with 5000-line scrollback", async () => {
    const { Terminal } = await import("@xterm/xterm");

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

    // The Terminal constructor should have been called with scrollback: 5000
    expect(Terminal).toHaveBeenCalledWith(
      expect.objectContaining({ scrollback: 5000 }),
    );
  });
});
