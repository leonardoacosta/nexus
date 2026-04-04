/**
 * AC-10: Health page renders machine cards for multiple agents.
 *
 * Given 3 agents each reporting health metrics,
 * the health page should render 3 machine cards with live data.
 */

import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeHealthMetrics, makeAgentStatus } from "./test-helpers";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/app/actions/health", () => ({
  fetchHealth: vi.fn(() =>
    Promise.resolve({
      metrics: [
        makeHealthMetrics({ agent: "alpha", hostname: "alpha-host" }),
        makeHealthMetrics({ agent: "beta", hostname: "beta-host" }),
        makeHealthMetrics({ agent: "gamma", hostname: "gamma-host" }),
      ],
      statuses: [
        makeAgentStatus({ name: "alpha", online: true }),
        makeAgentStatus({ name: "beta", online: true }),
        makeAgentStatus({ name: "gamma", online: true }),
      ],
    }),
  ),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { HealthPoller } from "@/components/HealthPoller";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AC-10: 3 agents — 3 health cards with live metrics", () => {
  it("renders 3 machine cards", () => {
    render(
      <HealthPoller
        initialMetrics={[
          makeHealthMetrics({ agent: "alpha", hostname: "alpha-host" }),
          makeHealthMetrics({ agent: "beta", hostname: "beta-host" }),
          makeHealthMetrics({ agent: "gamma", hostname: "gamma-host" }),
        ]}
        initialStatuses={[
          makeAgentStatus({ name: "alpha", online: true }),
          makeAgentStatus({ name: "beta", online: true }),
          makeAgentStatus({ name: "gamma", online: true }),
        ]}
      />,
    );

    expect(screen.getByText("alpha-host")).toBeInTheDocument();
    expect(screen.getByText("beta-host")).toBeInTheDocument();
    expect(screen.getByText("gamma-host")).toBeInTheDocument();
  });

  it("shows CPU and RAM gauges for each card", () => {
    render(
      <HealthPoller
        initialMetrics={[
          makeHealthMetrics({ agent: "alpha", hostname: "alpha-host" }),
          makeHealthMetrics({ agent: "beta", hostname: "beta-host" }),
          makeHealthMetrics({ agent: "gamma", hostname: "gamma-host" }),
        ]}
        initialStatuses={[
          makeAgentStatus({ name: "alpha", online: true }),
          makeAgentStatus({ name: "beta", online: true }),
          makeAgentStatus({ name: "gamma", online: true }),
        ]}
      />,
    );

    // Each card has CPU and RAM labels
    const cpuLabels = screen.getAllByText("CPU");
    expect(cpuLabels.length).toBe(3);

    const ramLabels = screen.getAllByText("RAM");
    expect(ramLabels.length).toBe(3);
  });

  it("shows uptime for each machine", () => {
    render(
      <HealthPoller
        initialMetrics={[
          makeHealthMetrics({ agent: "alpha", hostname: "alpha-host", uptime_seconds: 86400 }),
          makeHealthMetrics({ agent: "beta", hostname: "beta-host", uptime_seconds: 3600 }),
          makeHealthMetrics({ agent: "gamma", hostname: "gamma-host", uptime_seconds: 172800 }),
        ]}
        initialStatuses={[
          makeAgentStatus({ name: "alpha", online: true }),
          makeAgentStatus({ name: "beta", online: true }),
          makeAgentStatus({ name: "gamma", online: true }),
        ]}
      />,
    );

    expect(screen.getByText("up 1d")).toBeInTheDocument();
    expect(screen.getByText("up 1h")).toBeInTheDocument();
    expect(screen.getByText("up 2d")).toBeInTheDocument();
  });

  it("shows docker container counts", () => {
    render(
      <HealthPoller
        initialMetrics={[
          makeHealthMetrics({
            agent: "alpha",
            hostname: "alpha-host",
            docker: { containers: 5, running: 3 },
          }),
        ]}
        initialStatuses={[
          makeAgentStatus({ name: "alpha", online: true }),
        ]}
      />,
    );

    expect(screen.getByText("3/5 containers")).toBeInTheDocument();
  });
});
