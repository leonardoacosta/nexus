/**
 * spec-events-transport.test.ts
 *
 * Unit test: fetch is aborted when the hook unmounts mid-request.
 *
 * The `useSpecEventsStream` hook creates an AbortController each time it
 * calls `refetchAll`. On unmount, the cleanup function in `useEffect` calls
 * `refetchAbortRef.current?.abort()`. This ensures stale responses are
 * never applied to unmounted component state.
 *
 * We test this by:
 *   1. Rendering the hook with a mock `fetch` that captures the AbortSignal.
 *   2. Triggering `refetchAll` (by simulating an EventSource reconnect).
 *   3. Unmounting the hook before the fetch resolves.
 *   4. Asserting the captured AbortSignal.aborted === true.
 *
 * We also directly test the `refetchAll` abort path by mocking fetch with a
 * never-resolving promise and verifying abort behaviour.
 */

import { renderHook, act, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { UseSpecEventsStreamOptions } from "./spec-events-transport";

// ---------------------------------------------------------------------------
// EventSource stub — jsdom does not ship EventSource.
// ---------------------------------------------------------------------------

class StubEventSource {
  static instances: StubEventSource[] = [];

  url: string;
  readyState = 0;
  private _listeners: Map<string, Set<(evt: Event) => void>> = new Map();

  constructor(url: string) {
    this.url = url;
    StubEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (evt: Event) => void): void {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type)!.add(handler);
  }

  removeEventListener(type: string, handler: (evt: Event) => void): void {
    this._listeners.get(type)?.delete(handler);
  }

  dispatchEvent(type: string, data?: unknown): void {
    const evt = Object.assign(new Event(type), data ? { data } : {});
    this._listeners.get(type)?.forEach((h) => h(evt));
  }

  close(): void {
    this.readyState = 2;
  }

  static reset(): void {
    StubEventSource.instances = [];
  }
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  StubEventSource.reset();
  // Replace global EventSource with stub.
  // @ts-expect-error - intentional stub replacement
  globalThis.EventSource = StubEventSource;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Import after global setup.
// ---------------------------------------------------------------------------

import { useSpecEventsStream } from "./spec-events-transport";
import type { ProjectSpecStatus } from "./types";

const INITIAL_PROJECTS: ProjectSpecStatus[] = [
  {
    code: "nx",
    name: "Nexus",
    specs: [],
    beads: null,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSpecEventsStream — AbortController on unmount", () => {
  it("aborts an in-flight refetchAll fetch when the hook unmounts", async () => {
    // Track the AbortSignal passed to fetch.
    let capturedSignal: AbortSignal | undefined;
    let resolveFetch!: (value: Response) => void;
    const neverResolvingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal | undefined;
        return neverResolvingFetch;
      }),
    );

    const options: UseSpecEventsStreamOptions = {
      initialProjects: INITIAL_PROJECTS,
      agentBaseUrl: "http://localhost:7400",
    };

    const { unmount } = renderHook(() => useSpecEventsStream(options));

    // Wait a tick for EventSource to be created and connect handler to fire.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Simulate the EventSource "open" event (triggers reconnect-path refetchAll
    // only when hasDisconnectedRef is true). To trigger refetchAll unconditionally,
    // we verify the AbortController wire-up by triggering a reconnect first:
    const es = StubEventSource.instances[0];
    // Simulate a disconnect followed by reconnect — sets hasDisconnectedRef.
    await act(async () => {
      es?.dispatchEvent("error");
      await new Promise((r) => setTimeout(r, 0));
    });

    // After backoff, a new EventSource will be created and connected.
    // Drive time forward to trigger backoff (1000ms first attempt).
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    vi.useRealTimers();

    // Give async events a turn.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const es2 = StubEventSource.instances[StubEventSource.instances.length - 1];
    await act(async () => {
      es2?.dispatchEvent("open");
      await new Promise((r) => setTimeout(r, 0));
    });

    // fetch should have been called with an AbortSignal.
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    // Unmount — cleanup should abort the in-flight request.
    unmount();

    expect(capturedSignal!.aborted).toBe(true);

    // Resolve the fetch after abort to avoid unhandled rejection.
    resolveFetch(new Response(null, { status: 200 }));
  });

  it("aborts a previous in-flight refetchAll before starting a new one", async () => {
    const signals: AbortSignal[] = [];
    let callCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        callCount += 1;
        if (init?.signal) signals.push(init.signal as AbortSignal);
        // Never resolves — simulates a slow network.
        return new Promise<Response>(() => undefined);
      }),
    );

    const options: UseSpecEventsStreamOptions = {
      initialProjects: INITIAL_PROJECTS,
      agentBaseUrl: "http://localhost:7400",
    };

    const { unmount } = renderHook(() => useSpecEventsStream(options));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const es = StubEventSource.instances[0];

    // First disconnect: triggers future reconnect path.
    await act(async () => {
      es?.dispatchEvent("error");
      await new Promise((r) => setTimeout(r, 0));
    });

    // Advance past first backoff.
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    vi.useRealTimers();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const es2 = StubEventSource.instances[StubEventSource.instances.length - 1];
    // First reconnect → triggers first refetchAll.
    await act(async () => {
      es2?.dispatchEvent("open");
      await new Promise((r) => setTimeout(r, 0));
    });

    const firstSignal = signals[0];
    expect(firstSignal).toBeDefined();
    expect(firstSignal!.aborted).toBe(false);

    // Second disconnect.
    await act(async () => {
      es2?.dispatchEvent("error");
      await new Promise((r) => setTimeout(r, 0));
    });

    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    vi.useRealTimers();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const es3 = StubEventSource.instances[StubEventSource.instances.length - 1];
    // Second reconnect → triggers second refetchAll; should abort the first.
    await act(async () => {
      es3?.dispatchEvent("open");
      await new Promise((r) => setTimeout(r, 0));
    });

    // First in-flight request should have been aborted.
    expect(firstSignal!.aborted).toBe(true);

    unmount();
  });

  it("fetch is never called when agentBaseUrl is null", () => {
    vi.stubGlobal("fetch", vi.fn());

    const { unmount } = renderHook(() =>
      useSpecEventsStream({
        initialProjects: INITIAL_PROJECTS,
        agentBaseUrl: null,
      }),
    );

    unmount();

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});
