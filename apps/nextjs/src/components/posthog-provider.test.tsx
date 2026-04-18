/**
 * PostHogProvider contract tests — spec: add-dashboard-observability-baseline
 *
 * Verifies:
 *   3.2 — no-ops (no posthog.init call) when NEXT_PUBLIC_POSTHOG_KEY is unset
 *   3.2 — calls posthog.init with (key, { api_host }) when key is set
 *   3.2 — children render in both cases
 *
 * Design note: posthog-provider.tsx reads NEXT_PUBLIC_POSTHOG_KEY at module
 * scope (a const). vi.stubEnv after import has no effect on already-evaluated
 * module-level code. We use vi.resetModules() + dynamic import so each test
 * gets a fresh module evaluation with the desired env state.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import React from "react";

// vi.hoisted runs before module evaluation — the spy reference is available
// inside the vi.mock factory before any import runs.
const { mockInit } = vi.hoisted(() => ({
  mockInit: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: {
    init: mockInit,
  },
}));

beforeEach(() => {
  mockInit.mockClear();
  vi.resetModules();
  vi.unstubAllEnvs();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

async function importProvider() {
  // Dynamic import after env mutation ensures the module-level POSTHOG_KEY
  // const is evaluated with the current env state.
  const mod = await import("./posthog-provider");
  return mod.default;
}

describe("PostHogProvider", () => {
  describe("when NEXT_PUBLIC_POSTHOG_KEY is unset", () => {
    it("does NOT call posthog.init", async () => {
      vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
      const PostHogProvider = await importProvider();

      await act(async () => {
        render(
          React.createElement(PostHogProvider, null, React.createElement("span", null, "child"))
        );
      });

      expect(mockInit).not.toHaveBeenCalled();
    });

    it("still renders children", async () => {
      vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
      const PostHogProvider = await importProvider();

      await act(async () => {
        render(
          React.createElement(
            PostHogProvider,
            null,
            React.createElement("span", { "data-testid": "child" }, "hello")
          )
        );
      });

      expect(screen.getByTestId("child")).toBeDefined();
    });

    it("does not throw", async () => {
      vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
      const PostHogProvider = await importProvider();

      await expect(
        act(async () => {
          render(
            React.createElement(PostHogProvider, null, React.createElement("span", null, "safe"))
          );
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("when NEXT_PUBLIC_POSTHOG_KEY is set", () => {
    it("calls posthog.init with the key", async () => {
      vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test123");
      const PostHogProvider = await importProvider();

      await act(async () => {
        render(
          React.createElement(PostHogProvider, null, React.createElement("span", null, "child"))
        );
      });

      expect(mockInit).toHaveBeenCalledWith(
        "phc_test123",
        expect.objectContaining({ api_host: expect.any(String) }),
      );
    });

    it("calls posthog.init exactly once", async () => {
      vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test123");
      const PostHogProvider = await importProvider();

      await act(async () => {
        render(
          React.createElement(PostHogProvider, null, React.createElement("span", null, "child"))
        );
      });

      expect(mockInit).toHaveBeenCalledTimes(1);
    });

    it("renders children when key is set", async () => {
      vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test123");
      const PostHogProvider = await importProvider();

      await act(async () => {
        render(
          React.createElement(
            PostHogProvider,
            null,
            React.createElement("span", { "data-testid": "child-set" }, "hello")
          )
        );
      });

      expect(screen.getByTestId("child-set")).toBeDefined();
    });
  });
});
