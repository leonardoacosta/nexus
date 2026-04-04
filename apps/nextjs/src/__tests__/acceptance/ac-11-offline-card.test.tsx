/**
 * AC-11: Agent offline 12min — grayed card, "Last seen 12m ago".
 *
 * Verifies that an offline agent renders as a grayed-out card
 * with the correct "Last seen" timestamp.
 */

import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeAgentStatus, makeHealthMetrics } from "./test-helpers";

vi.mock("@/app/actions/health", () => ({
  fetchHealth: vi.fn(() => Promise.resolve({ metrics: [], statuses: [] })),
}));

import { OfflineMachineCard } from "@/components/OfflineMachineCard";
import { HealthPoller } from "@/components/HealthPoller";

afterEach(() => {
  cleanup();
});

describe("AC-11: Offline agent — grayed card with 'Last seen' display", () => {
  it("renders grayed card for 12-minute offline agent", () => {
    const agent = makeAgentStatus({
      name: "build-box",
      online: false,
      lastSeen: new Date(Date.now() - 12 * 60_000), // 12 min ago
    });

    render(<OfflineMachineCard agent={agent} />);

    expect(screen.getByText("build-box")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("Last seen 12m ago")).toBeInTheDocument();
  });

  it("applies grayed-out visual style", () => {
    const agent = makeAgentStatus({
      name: "build-box",
      online: false,
      lastSeen: new Date(Date.now() - 12 * 60_000),
    });

    const { container } = render(<OfflineMachineCard agent={agent} />);

    // The card should have reduced opacity
    const card = container.firstElementChild as HTMLElement;
    expect(card.style.opacity).toBe("0.5");
    expect(card.style.filter).toContain("grayscale");
  });

  it("renders offline card alongside online cards in HealthPoller", () => {
    render(
      <HealthPoller
        initialMetrics={[
          makeHealthMetrics({ agent: "alpha", hostname: "alpha-host" }),
        ]}
        initialStatuses={[
          makeAgentStatus({ name: "alpha", online: true }),
          makeAgentStatus({
            name: "build-box",
            online: false,
            lastSeen: new Date(Date.now() - 12 * 60_000),
          }),
        ]}
      />,
    );

    // Online card
    expect(screen.getByText("alpha-host")).toBeInTheDocument();
    // Offline card
    expect(screen.getByText("build-box")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("Last seen 12m ago")).toBeInTheDocument();
  });
});
