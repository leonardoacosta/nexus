/**
 * AC-8: Ctrl+C — 0x03 sent, interrupt result renders.
 *
 * Verifies that control characters are properly forwarded
 * through the terminal's onData/onBinary handlers.
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

describe("AC-8: Ctrl+C sends 0x03 byte", () => {
  it("sends Ctrl+C (0x03) via onData handler", async () => {
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

    // Get the onData callback
    const onDataCallback = mockTerminal.onData.mock.calls[0]?.[0];
    expect(onDataCallback).toBeDefined();

    // Simulate Ctrl+C — xterm sends "\x03" as a string via onData
    act(() => {
      onDataCallback("\x03");
    });

    // The component encodes text via TextEncoder and sends as Uint8Array.
    // Find the send call that contains 0x03.
    const sendCalls = ws.send.mock.calls;
    // Filter to binary calls (skip the initial resize JSON string)
    const binaryCalls = sendCalls.filter(
      (call: unknown[]) => !(typeof call[0] === "string"),
    );
    expect(binaryCalls.length).toBeGreaterThanOrEqual(1);

    // The sent payload should contain byte 0x03
    const payload = binaryCalls[0]![0] as Uint8Array;
    expect(payload.length).toBe(1);
    expect(payload[0]).toBe(0x03);
  });

  it("sends Ctrl+D (0x04) via onData handler", async () => {
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

    const onDataCallback = mockTerminal.onData.mock.calls[0]?.[0];
    expect(onDataCallback).toBeDefined();

    // Ctrl+D = 0x04
    act(() => {
      onDataCallback("\x04");
    });

    const sendCalls = ws.send.mock.calls;
    const binaryCalls = sendCalls.filter(
      (call: unknown[]) => !(typeof call[0] === "string"),
    );
    expect(binaryCalls.length).toBeGreaterThanOrEqual(1);

    const payload = binaryCalls[0]![0] as Uint8Array;
    expect(payload.length).toBe(1);
    expect(payload[0]).toBe(0x04);
  });

  it("forwards raw binary via onBinary handler", async () => {
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

    const onBinaryCallback = mockTerminal.onBinary.mock.calls[0]?.[0];
    expect(onBinaryCallback).toBeDefined();

    // onBinary receives a string where each char is a byte value
    act(() => {
      onBinaryCallback("\x03");
    });

    const sendCalls = ws.send.mock.calls;
    const binaryCalls = sendCalls.filter(
      (call: unknown[]) => !(typeof call[0] === "string"),
    );
    expect(binaryCalls.length).toBeGreaterThanOrEqual(1);

    const payload = binaryCalls[0]![0] as Uint8Array;
    expect(payload.length).toBe(1);
    expect(payload[0]).toBe(0x03);
  });
});
