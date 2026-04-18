/**
 * spec-events-subscriber.test.tsx
 *
 * Verifies that the SpecEventsSubscriber renders spec names as plain text,
 * preventing script injection via malicious SSE payloads.
 *
 * The component uses React's JSX rendering (`{spec.name}`) rather than
 * dangerouslySetInnerHTML, so browsers never parse injected HTML. This test
 * confirms that even a payload containing a <script> tag is rendered as a
 * visible text string and does NOT execute any code.
 */

import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ProjectSpecStatus } from "./types";

// ---------------------------------------------------------------------------
// Mocks — isolate the component from network I/O.
// ---------------------------------------------------------------------------

// Mock the transport hook so the component renders with controlled data
// without opening any EventSource or fetch connections.
vi.mock("./spec-events-transport", async (importOriginal) => {
  const original = await importOriginal<typeof import("./spec-events-transport")>();
  return {
    ...original,
    useSpecEventsStream: vi.fn(() => ({
      projects: [],
      status: "connecting" as const,
      recentlyChanged: new Set<string>(),
    })),
  };
});

// ---------------------------------------------------------------------------
// Import after mocks.
// ---------------------------------------------------------------------------

import { SpecEventsSubscriber } from "./spec-events-subscriber";
import { useSpecEventsStream } from "./spec-events-transport";

const mockUseStream = vi.mocked(useSpecEventsStream);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(specName: string): ProjectSpecStatus {
  return {
    code: "nx",
    name: "Nexus",
    specs: [
      {
        name: specName,
        status: "active",
        completed_tasks: 0,
        total_tasks: 5,
        last_modified: null,
      },
    ],
    beads: null,
  };
}

// ---------------------------------------------------------------------------
// XSS tests
// ---------------------------------------------------------------------------

describe("SpecEventsSubscriber — XSS prevention", () => {
  it("renders a malicious script tag as literal text, not as HTML", () => {
    const maliciousSpecName = '<script>window.__pwned = true</script>';

    mockUseStream.mockReturnValue({
      projects: [makeProject(maliciousSpecName)],
      status: "open",
      recentlyChanged: new Set(),
    });

    render(
      <SpecEventsSubscriber
        initialProjects={[makeProject(maliciousSpecName)]}
        agentBaseUrl="http://localhost:7400"
      />,
    );

    // The spec name must appear as visible, escaped text in the DOM.
    expect(
      screen.getByText('<script>window.__pwned = true</script>'),
    ).toBeInTheDocument();

    // The injected script must NOT have executed.
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it("does not create a <script> element for an injected script payload", () => {
    const maliciousSpecName = '<script>window.__pwned2 = true</script>';

    mockUseStream.mockReturnValue({
      projects: [makeProject(maliciousSpecName)],
      status: "open",
      recentlyChanged: new Set(),
    });

    render(
      <SpecEventsSubscriber
        initialProjects={[makeProject(maliciousSpecName)]}
        agentBaseUrl="http://localhost:7400"
      />,
    );

    // No injected <script> elements should exist beyond the static SPEC_ROW_CSS
    // <style> tag; specifically, zero <script> tags.
    const scripts = document.querySelectorAll("script");
    expect(scripts.length).toBe(0);
  });

  it("renders a payload with an img onerror attribute as plain text", () => {
    const maliciousSpecName = '<img src=x onerror="window.__pwned3=true">';

    mockUseStream.mockReturnValue({
      projects: [makeProject(maliciousSpecName)],
      status: "open",
      recentlyChanged: new Set(),
    });

    render(
      <SpecEventsSubscriber
        initialProjects={[makeProject(maliciousSpecName)]}
        agentBaseUrl="http://localhost:7400"
      />,
    );

    // Literal text should be present.
    expect(
      screen.getByText(maliciousSpecName),
    ).toBeInTheDocument();

    // No img elements created by the payload (only text nodes expected).
    const imgs = document.querySelectorAll('img[src="x"]');
    expect(imgs.length).toBe(0);

    expect((window as unknown as Record<string, unknown>).__pwned3).toBeUndefined();
  });

  it("renders a normal spec name without escaping it unnecessarily", () => {
    const normalSpecName = "unify-session-credential-types";

    mockUseStream.mockReturnValue({
      projects: [makeProject(normalSpecName)],
      status: "open",
      recentlyChanged: new Set(),
    });

    render(
      <SpecEventsSubscriber
        initialProjects={[makeProject(normalSpecName)]}
        agentBaseUrl="http://localhost:7400"
      />,
    );

    expect(screen.getByText(normalSpecName)).toBeInTheDocument();
  });
});
