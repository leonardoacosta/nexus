import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MachineCard } from "../MachineCard";
import type { HealthMetrics } from "@nexus/core";
import type { WithAgent } from "@/lib/agent-client";

function makeMetrics(overrides: Partial<WithAgent<HealthMetrics>> = {}): WithAgent<HealthMetrics> {
  return {
    hostname: "dev-server",
    uptime_seconds: 86400,
    cpu: {
      overall_percent: 45,
      per_core_percent: [40, 50],
      load_average: [1.5, 1.2, 0.9],
    },
    ram: {
      total_bytes: 16_000_000_000,
      used_bytes: 8_000_000_000,
      percent: 50,
    },
    disk: [
      {
        mount: "/",
        total_bytes: 500_000_000_000,
        used_bytes: 200_000_000_000,
        percent: 40,
      },
    ],
    docker: { containers: 5, running: 3 },
    processes: {
      top_cpu: [
        { pid: 1, name: "node", cpu_percent: 25, ram_percent: 10 },
        { pid: 2, name: "rust-analyzer", cpu_percent: 15, ram_percent: 8 },
      ],
      top_ram: [
        { pid: 3, name: "chrome", cpu_percent: 5, ram_percent: 30 },
      ],
    },
    agent: "dev-server",
    ...overrides,
  };
}

describe("MachineCard", () => {
  it("renders hostname and uptime", () => {
    render(<MachineCard metrics={makeMetrics()} />);
    const hostnames = screen.getAllByText("dev-server");
    expect(hostnames.length).toBeGreaterThanOrEqual(1);
    const uptimes = screen.getAllByText("up 1d");
    expect(uptimes.length).toBeGreaterThanOrEqual(1);
  });

  it("renders docker container count", () => {
    render(<MachineCard metrics={makeMetrics()} />);
    const containers = screen.getAllByText("3/5 containers");
    expect(containers.length).toBeGreaterThanOrEqual(1);
  });

  it("renders CPU and RAM gauge labels", () => {
    render(<MachineCard metrics={makeMetrics()} />);
    const cpuLabels = screen.getAllByText("CPU");
    expect(cpuLabels.length).toBeGreaterThanOrEqual(1);
    const ramLabels = screen.getAllByText("RAM");
    expect(ramLabels.length).toBeGreaterThanOrEqual(1);
  });

  it("expands to show processes on click", () => {
    render(<MachineCard metrics={makeMetrics()} />);

    // Detail not visible initially
    expect(screen.queryByText("Top Processes (CPU)")).not.toBeInTheDocument();

    // Click "Show details"
    const showButtons = screen.getAllByText("Show details");
    fireEvent.click(showButtons[0]!);

    const headers = screen.getAllByText("Top Processes (CPU)");
    expect(headers.length).toBeGreaterThanOrEqual(1);
    const nodes = screen.getAllByText("node");
    expect(nodes.length).toBeGreaterThanOrEqual(1);

    // Click "Hide details"
    const hideButtons = screen.getAllByText("Hide details");
    fireEvent.click(hideButtons[0]!);
    expect(screen.queryByText("Top Processes (CPU)")).not.toBeInTheDocument();
  });
});
