/**
 * Smoke test for the project-detail live-sync subcomponent.
 *
 * Mirrors the pattern in `session/[id]/page.test.tsx` — we test the
 * `<ProjectLiveSync project={...} />` subcomponent in isolation rather
 * than the full RSC page. The behavioral contract is identical:
 * `router.refresh()` fires only when an event arrives for THIS project.
 *
 * Spec: openspec/changes/add-hooks-sse-fanout/specs/hooks-endpoint/spec.md
 *       § "Project page filters by project"
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { ProjectLiveSync } from "@/components/ProjectLiveSync";

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
  (globalThis as unknown as { EventSource: unknown }).EventSource = Stub;
  return instances;
}

afterEach(() => {
  cleanup();
  refresh.mockReset();
});

describe("ProjectLiveSync", () => {
  it("calls router.refresh when an event arrives for this project", () => {
    const instances = installEventSourceStub();

    render(<ProjectLiveSync project="oo" />);
    const es = instances[0]!;

    act(() => {
      es.dispatch("message", {
        data: JSON.stringify({
          event: "HookEventReceived",
          payload: {
            eventType: "session_start",
            sessionId: "abc-123",
            project: "oo",
            eventId: 1,
          },
        }),
      });
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores events for a different project", () => {
    const instances = installEventSourceStub();

    render(<ProjectLiveSync project="oo" />);
    const es = instances[0]!;

    act(() => {
      es.dispatch("message", {
        data: JSON.stringify({
          event: "HookEventReceived",
          payload: {
            eventType: "session_start",
            sessionId: "abc-123",
            project: "tl",
            eventId: 1,
          },
        }),
      });
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  it("ignores events with no project field", () => {
    const instances = installEventSourceStub();

    render(<ProjectLiveSync project="oo" />);
    const es = instances[0]!;

    act(() => {
      es.dispatch("message", {
        data: JSON.stringify({
          event: "HookEventReceived",
          payload: { eventType: "session_start", sessionId: "abc-123", eventId: 1 },
        }),
      });
    });

    expect(refresh).not.toHaveBeenCalled();
  });
});
