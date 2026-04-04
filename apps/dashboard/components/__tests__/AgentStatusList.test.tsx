import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AgentStatusList } from "../AgentStatusList";
import type { AgentStatus } from "@/lib/agent-client";

function makeAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    name: "dev-server",
    online: true,
    lastSeen: new Date(),
    ...overrides,
  };
}

describe("AgentStatusList", () => {
  it("renders empty state when no agents", () => {
    render(<AgentStatusList agents={[]} />);
    expect(screen.getByText("No agents configured")).toBeInTheDocument();
  });

  it("renders agent name and online badge", () => {
    render(
      <AgentStatusList
        agents={[makeAgent({ name: "alpha", online: true })]}
      />,
    );
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("renders offline badge for offline agent", () => {
    render(
      <AgentStatusList
        agents={[
          makeAgent({
            name: "beta",
            online: false,
            lastSeen: new Date(Date.now() - 600_000),
          }),
        ]}
      />,
    );
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("shows 'Never connected' when lastSeen is null", () => {
    render(
      <AgentStatusList
        agents={[makeAgent({ name: "gamma", online: false, lastSeen: null })]}
      />,
    );
    expect(screen.getByText("Never connected")).toBeInTheDocument();
  });

  it("renders multiple agents", () => {
    render(
      <AgentStatusList
        agents={[
          makeAgent({ name: "alpha-unique", online: true }),
          makeAgent({ name: "beta-unique", online: false }),
          makeAgent({ name: "gamma-unique", online: true }),
        ]}
      />,
    );
    expect(screen.getByText("alpha-unique")).toBeInTheDocument();
    expect(screen.getByText("beta-unique")).toBeInTheDocument();
    expect(screen.getByText("gamma-unique")).toBeInTheDocument();
  });

  it("renders status dots for each agent", () => {
    const { container } = render(
      <AgentStatusList
        agents={[
          makeAgent({ name: "alpha", online: true }),
          makeAgent({ name: "beta", online: false }),
        ]}
      />,
    );
    const statusDots = container.querySelectorAll("[role='status']");
    expect(statusDots.length).toBe(2);
    expect(statusDots[0]).toHaveAttribute("aria-label", "active");
    expect(statusDots[1]).toHaveAttribute("aria-label", "ended");
  });
});
