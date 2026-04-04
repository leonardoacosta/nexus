/**
 * AC-6: Offline agent detection.
 *
 * Verifies that the AgentClient correctly marks agents as offline
 * when they fail to respond, and the UI reflects this state.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { makeAgentStatus, makeHealthMetrics } from "./test-helpers";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Agent client offline detection (unit-level)
// ---------------------------------------------------------------------------

import { AgentClient } from "@/lib/agent-client";

describe("AC-6: Offline agent detection — AgentClient", () => {
  it("marks agent as offline when never contacted", () => {
    const client = new AgentClient([
      { name: "unreachable", host: "192.168.1.99", port: 7400 },
    ]);

    const statuses = client.getAgentStatuses();
    expect(statuses.length).toBe(1);
    expect(statuses[0]!.name).toBe("unreachable");
    expect(statuses[0]!.online).toBe(false);
    expect(statuses[0]!.lastSeen).toBeNull();
  });

  it("returns offline for all agents before any fetch", () => {
    const client = new AgentClient([
      { name: "alpha", host: "100.64.0.1", port: 7400 },
      { name: "beta", host: "100.64.0.2", port: 7400 },
    ]);

    const statuses = client.getAgentStatuses();
    expect(statuses.every((s) => !s.online)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UI offline detection — OfflineMachineCard
// ---------------------------------------------------------------------------

import { OfflineMachineCard } from "@/components/OfflineMachineCard";

describe("AC-6: Offline agent detection — OfflineMachineCard", () => {
  it("renders grayed card with Offline badge", () => {
    const agent = makeAgentStatus({
      name: "build-box",
      online: false,
      lastSeen: new Date(Date.now() - 300_000), // 5 min ago
    });

    render(<OfflineMachineCard agent={agent} />);

    expect(screen.getByText("build-box")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("shows 'Last seen' timestamp for previously online agent", () => {
    const agent = makeAgentStatus({
      name: "build-box",
      online: false,
      lastSeen: new Date(Date.now() - 300_000), // 5 min ago
    });

    render(<OfflineMachineCard agent={agent} />);

    expect(screen.getByText(/Last seen 5m ago/)).toBeInTheDocument();
  });

  it("shows 'Never connected' for agent with null lastSeen", () => {
    const agent = makeAgentStatus({
      name: "new-box",
      online: false,
      lastSeen: null,
    });

    render(<OfflineMachineCard agent={agent} />);

    expect(screen.getByText("Never connected")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// UI offline detection — HealthPoller integration
// ---------------------------------------------------------------------------

vi.mock("@/app/actions/health", () => ({
  fetchHealth: vi.fn(() =>
    Promise.resolve({
      metrics: [makeHealthMetrics({ agent: "alpha", hostname: "alpha" })],
      statuses: [
        makeAgentStatus({ name: "alpha", online: true }),
        makeAgentStatus({ name: "beta", online: false, lastSeen: new Date(Date.now() - 300_000) }),
      ],
    }),
  ),
}));

import { HealthPoller } from "@/components/HealthPoller";

describe("AC-6: Offline agent detection — HealthPoller", () => {
  it("renders online machine cards and offline cards", () => {
    render(
      <HealthPoller
        initialMetrics={[makeHealthMetrics({ agent: "alpha", hostname: "alpha" })]}
        initialStatuses={[
          makeAgentStatus({ name: "alpha", online: true }),
          makeAgentStatus({ name: "beta", online: false, lastSeen: new Date(Date.now() - 300_000) }),
        ]}
      />,
    );

    // Online agent should show hostname
    expect(screen.getByText("alpha")).toBeInTheDocument();
    // Offline agent should show name and offline status
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });
});
