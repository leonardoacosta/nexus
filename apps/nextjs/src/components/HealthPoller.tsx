"use client";

import { useState, useEffect, useCallback } from "react";
import type { HealthMetrics } from "@nexus/core";
import type { WithAgent, AgentStatus } from "@/lib/agent-client";
import { fetchHealth } from "@/app/actions/health";
import { MachineCard } from "./MachineCard";
import { OfflineMachineCard } from "./OfflineMachineCard";

interface HealthPollerProps {
  initialMetrics: WithAgent<HealthMetrics>[];
  initialStatuses: AgentStatus[];
}

export function HealthPoller({
  initialMetrics,
  initialStatuses,
}: HealthPollerProps) {
  const [metrics, setMetrics] = useState(initialMetrics);
  const [statuses, setStatuses] = useState(initialStatuses);

  // Keep history for sparklines (last 60 data points per agent)
  const [cpuHistories, setCpuHistories] = useState<Map<string, number[]>>(
    () => new Map(initialMetrics.map((m) => [m.agent, [m.cpu.overall_percent]])),
  );
  const [ramHistories, setRamHistories] = useState<Map<string, number[]>>(
    () => new Map(initialMetrics.map((m) => [m.agent, [m.ram.percent]])),
  );

  const poll = useCallback(async () => {
    try {
      const result = await fetchHealth();
      setMetrics(result.metrics);
      setStatuses(result.statuses);

      // Append to history, capping at 60 entries
      setCpuHistories((prev) => {
        const next = new Map(prev);
        for (const m of result.metrics) {
          const history = next.get(m.agent) ?? [];
          next.set(m.agent, [...history.slice(-59), m.cpu.overall_percent]);
        }
        return next;
      });
      setRamHistories((prev) => {
        const next = new Map(prev);
        for (const m of result.metrics) {
          const history = next.get(m.agent) ?? [];
          next.set(m.agent, [...history.slice(-59), m.ram.percent]);
        }
        return next;
      });
    } catch (err) {
      // Keep existing data on failure — log so stale periods are visible in browser console
      console.warn("HealthPoller: fetchHealth failed — retaining stale data", err);
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [poll]);

  // Determine which agents are offline (in statuses but not in metrics)
  const onlineAgentNames = new Set(metrics.map((m) => m.agent));
  const offlineAgents = statuses.filter((s) => !s.online && !onlineAgentNames.has(s.name));

  if (metrics.length === 0 && offlineAgents.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--space-16) var(--space-4)",
          color: "var(--color-fg-muted)",
          textAlign: "center",
        }}
      >
        <p style={{ fontSize: "var(--font-size-lg)" }}>No machines reporting</p>
        <p style={{ fontSize: "var(--font-size-sm)", marginTop: "var(--space-2)" }}>
          Waiting for agents to connect...
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
        gap: "var(--space-4)",
      }}
    >
      {metrics.map((m) => {
        const isStale =
          m.collectedAt != null &&
          Date.now() - new Date(m.collectedAt).getTime() > 30_000;
        return (
          <div key={m.agent} style={{ position: "relative" }}>
            {isStale && (
              <span
                style={{
                  position: "absolute",
                  top: "var(--space-2)",
                  right: "var(--space-2)",
                  zIndex: 1,
                  backgroundColor: "var(--color-warning, #d97706)",
                  color: "#fff",
                  fontSize: "var(--font-size-xs, 0.75rem)",
                  fontWeight: 600,
                  padding: "2px 8px",
                  borderRadius: "9999px",
                }}
              >
                Stale
              </span>
            )}
            <MachineCard
              metrics={m}
              cpuHistory={cpuHistories.get(m.agent)}
              ramHistory={ramHistories.get(m.agent)}
            />
          </div>
        );
      })}
      {offlineAgents.map((agent) => (
        <OfflineMachineCard key={agent.name} agent={agent} />
      ))}
    </div>
  );
}
