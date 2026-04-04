import { render, screen, act, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock xterm.js — jsdom doesn't support canvas
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

const mockFit = { fit: vi.fn(), dispose: vi.fn() };
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function () { return mockFit; }),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function () { return { onContextLoss: vi.fn(), dispose: vi.fn() }; }),
}));

// Suppress xterm CSS import
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
  readyState = 0; // CONNECTING
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

  // Reset mocks
  mockTerminal.open.mockReset();
  mockTerminal.write.mockReset();
  mockTerminal.dispose.mockReset();
  mockTerminal.loadAddon.mockReset();
  mockTerminal.onData.mockReset();
  mockTerminal.onBinary.mockReset();
  mockFit.fit.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

import { XTerminal } from "../XTerminal";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("XTerminal", () => {
  it("renders terminal container and status indicator", async () => {
    render(
      <XTerminal
        agentHost="127.0.0.1:7400"
        sessionId="sess-1"
        mode="stream"
      />,
    );

    expect(screen.getByTestId("terminal-container")).toBeInTheDocument();
    expect(screen.getByTestId("connection-status")).toBeInTheDocument();
    expect(screen.getByTestId("status-text")).toHaveTextContent("Disconnected");
  });

  it("creates Terminal and opens it in the container", async () => {
    render(
      <XTerminal
        agentHost="127.0.0.1:7400"
        sessionId="sess-1"
        mode="stream"
      />,
    );

    // Let async init resolve
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(mockTerminal.open).toHaveBeenCalled();
    expect(mockFit.fit).toHaveBeenCalled();
  });

  it("shows connected status when WS opens", async () => {
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

    // Simulate WS open
    const ws = mockWsInstances[mockWsInstances.length - 1]!;
    act(() => {
      ws.readyState = 1;
      ws.onopen?.(new Event("open"));
    });

    expect(screen.getByTestId("status-text")).toHaveTextContent("Connected");
    expect(screen.getByTestId("status-dot")).toHaveAttribute("aria-label", "connected");
  });

  it("shows reconnecting then disconnected after max retries", async () => {
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

    // First close → reconnecting
    let ws = mockWsInstances[mockWsInstances.length - 1]!;
    act(() => {
      ws.onclose?.(new CloseEvent("close"));
    });
    expect(screen.getByTestId("status-text")).toHaveTextContent("Reconnecting...");

    // Advance through all retries (1s, 2s, 4s = 3 retries)
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      ws = mockWsInstances[mockWsInstances.length - 1]!;
      act(() => {
        ws.onclose?.(new CloseEvent("close"));
      });
    }

    expect(screen.getByTestId("status-text")).toHaveTextContent("Disconnected");
  });

  it("writes incoming data to terminal", async () => {
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

    // Send text data (non-JSON falls through to term.write)
    act(() => {
      ws.onmessage?.(new MessageEvent("message", { data: "Hello, terminal!" }));
    });

    expect(mockTerminal.write).toHaveBeenCalledWith("Hello, terminal!");

    // Also test binary data via ArrayBuffer
    mockTerminal.write.mockReset();
    const buf = new TextEncoder().encode("binary payload").buffer;
    const msgEvent = new MessageEvent("message", { data: buf });
    // jsdom MessageEvent may not preserve ArrayBuffer identity;
    // verify the component handles it when instanceof check succeeds
    if (msgEvent.data instanceof ArrayBuffer) {
      act(() => {
        ws.onmessage?.(msgEvent);
      });
      expect(mockTerminal.write).toHaveBeenCalledWith(expect.any(Uint8Array));
    }
  });

  it("handles session_ended control frame", async () => {
    const onControl = vi.fn();

    render(
      <XTerminal
        agentHost="127.0.0.1:7400"
        sessionId="sess-1"
        mode="stream"
        onControlFrame={onControl}
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

    // Send session_ended control frame
    act(() => {
      ws.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "session_ended" }),
        }),
      );
    });

    expect(onControl).toHaveBeenCalledWith({ type: "session_ended" });
    expect(screen.getByTestId("status-text")).toHaveTextContent("Disconnected");
  });

  it("connects to correct WebSocket URL for stream mode", async () => {
    render(
      <XTerminal
        agentHost="100.64.0.1:7400"
        sessionId="sess-abc"
        mode="stream"
      />,
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const ws = mockWsInstances[mockWsInstances.length - 1]!;
    expect(ws.url).toBe("ws://100.64.0.1:7400/sessions/sess-abc/stream");
  });

  it("connects to correct WebSocket URL for interact mode", async () => {
    render(
      <XTerminal
        agentHost="100.64.0.1:7400"
        sessionId="sess-abc"
        mode="interact"
      />,
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const ws = mockWsInstances[mockWsInstances.length - 1]!;
    expect(ws.url).toBe("ws://100.64.0.1:7400/sessions/sess-abc/interact");
  });

  it("registers keyboard handlers in interact mode", async () => {
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

    // In interact mode, onData and onBinary should be registered
    expect(mockTerminal.onData).toHaveBeenCalled();
    expect(mockTerminal.onBinary).toHaveBeenCalled();
  });

  it("does not register keyboard handlers in stream mode", async () => {
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

    expect(mockTerminal.onData).not.toHaveBeenCalled();
    expect(mockTerminal.onBinary).not.toHaveBeenCalled();
  });

  it("sends initial resize in interact mode on connect", async () => {
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
      JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
    );
  });

  it("cleans up on unmount", async () => {
    const { unmount } = render(
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

    unmount();

    expect(ws.close).toHaveBeenCalled();
    expect(mockTerminal.dispose).toHaveBeenCalled();
  });
});
