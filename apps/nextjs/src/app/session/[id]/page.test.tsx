/**
 * Smoke test for the session-detail live-sync subcomponent.
 *
 * Rendering the full session-detail page in jsdom would require mocking
 * the entire data layer (`fetchSessionDetail`, lazy-loaded XTerm) and
 * the resolved `params` Promise. The behavior we actually need to pin is
 * narrow: when a `HookEventReceived` event arrives for THIS session,
 * `router.refresh()` is called; when it arrives for a different session,
 * `router.refresh()` is NOT called.
 *
 * That contract lives entirely in `<SessionLiveSync sessionId={...} />`,
 * so we test the subcomponent in isolation.
 *
 * Spec: openspec/changes/add-hooks-sse-fanout/specs/hooks-endpoint/spec.md
 *       § "Session detail page filters by sessionId"
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { SessionLiveSync } from "@/components/SessionLiveSync";

interface StubEventSource {
  url: string;
  closed: boolean;
  listeners: Map<string, Set<(evt: unknown) => void>>;
  addEventListener: (type: string, listener: (evt: unknown) => void) => void;
  close: () => void;
  dispatch: (type: string, evt: unknown) => void;
}

function installEventSourceStub(): StubEventSource[] {
  const instances: StubEventSource[] = [];
  class Stub implements StubEventSource {
    url: string;
    closed = false;
    listeners = new Map<string, Set<(evt: unknown) => void>>();
    constructor(url: string) {
      this.url = url;
      instances.push(this);
    }
    addEventListener(type: string, listener: (evt: unknown) => void) {
      const set = this.listeners.get(type) ?? new Set();
      set.add(listener);
      this.listeners.set(type, set);
    }
    close() {
      this.closed = true;
    }
    dispatch(type: string, evt: unknown) {
      const set = this.listeners.get(type);
      if (!set) return;
      for (const fn of set) fn(evt);
    }
  }
  // jsdom doesn't ship EventSource — install our stub on window.
  (globalThis as unknown as { EventSource: unknown }).EventSource = Stub;
  return instances;
}

afterEach(() => {
  cleanup();
  refresh.mockReset();
});

describe("SessionLiveSync", () => {
  it("calls router.refresh when a HookEventReceived arrives for this session", () => {
    const instances = installEventSourceStub();

    render(<SessionLiveSync sessionId="abc-123" />);

    expect(instances).toHaveLength(1);
    const es = instances[0]!;
    expect(es.url).toBe("/api/notifications/stream");

    act(() => {
      es.dispatch("message", {
        data: JSON.stringify({
          event: "HookEventReceived",
          payload: {
            eventType: "tool_use_end",
            sessionId: "abc-123",
            eventId: 42,
          },
        }),
      });
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores events for a different session", () => {
    const instances = installEventSourceStub();

    render(<SessionLiveSync sessionId="abc-123" />);
    const es = instances[0]!;

    act(() => {
      es.dispatch("message", {
        data: JSON.stringify({
          event: "HookEventReceived",
          payload: {
            eventType: "tool_use_end",
            sessionId: "other-session",
            eventId: 99,
          },
        }),
      });
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  it("closes the EventSource on unmount", () => {
    const instances = installEventSourceStub();

    const { unmount } = render(<SessionLiveSync sessionId="abc-123" />);
    const es = instances[0]!;

    expect(es.closed).toBe(false);
    unmount();
    expect(es.closed).toBe(true);
  });
});
