"use client";

import { useState } from "react";
import type { HealthMetrics } from "@nexus/core";
import type { WithAgent } from "@/lib/agent-client";
import { Card, Gauge, Sparkline } from "@/components/ui";
import { formatUptime, formatBytes } from "@/lib/format";

interface MachineCardProps {
  metrics: WithAgent<HealthMetrics>;
  /** History for sparklines — array of past metrics snapshots */
  cpuHistory?: number[];
  ramHistory?: number[];
}

export function MachineCard({ metrics, cpuHistory, ramHistory }: MachineCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "var(--space-3)",
        }}
      >
        <div>
          <h3
            style={{
              fontSize: "var(--font-size-base)",
              fontWeight: "var(--font-weight-semibold)",
              color: "var(--color-fg)",
              marginBottom: "var(--space-1)",
            }}
          >
            {metrics.hostname}
          </h3>
          <span
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-fg-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            up {formatUptime(metrics.uptime_seconds)}
          </span>
        </div>
        {metrics.docker && (
          <span
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-fg-dim)",
            }}
          >
            {metrics.docker.running}/{metrics.docker.containers} containers
          </span>
        )}
      </div>

      {/* Gauges */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
          }}
        >
          <div style={{ flex: 1 }}>
            <Gauge value={metrics.cpu.overall_percent} label="CPU" />
          </div>
          {cpuHistory && cpuHistory.length >= 2 && (
            <Sparkline data={cpuHistory} width={80} height={24} />
          )}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
          }}
        >
          <div style={{ flex: 1 }}>
            <Gauge value={metrics.ram.percent} label="RAM" />
          </div>
          {ramHistory && ramHistory.length >= 2 && (
            <Sparkline data={ramHistory} width={80} height={24} />
          )}
        </div>
        {metrics.disk.map((d) => (
          <Gauge
            key={d.mount}
            value={d.percent}
            label={d.mount === "/" ? "Disk" : d.mount}
          />
        ))}
      </div>

      {/* Expand/collapse detail panel */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "block",
          marginTop: "var(--space-3)",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: "var(--color-primary)",
          fontSize: "var(--font-size-xs)",
          fontFamily: "inherit",
        }}
      >
        {expanded ? "Hide details" : "Show details"}
      </button>

      {expanded && (
        <div
          style={{
            marginTop: "var(--space-3)",
            paddingTop: "var(--space-3)",
            borderTop: "1px solid var(--color-border)",
          }}
        >
          {/* Disk by mount */}
          {metrics.disk.length > 0 && (
            <div style={{ marginBottom: "var(--space-3)" }}>
              <h4
                style={{
                  fontSize: "var(--font-size-xs)",
                  fontWeight: "var(--font-weight-medium)",
                  color: "var(--color-fg-dim)",
                  textTransform: "uppercase" as const,
                  letterSpacing: "var(--tracking-wide)",
                  marginBottom: "var(--space-2)",
                }}
              >
                Disk Mounts
              </h4>
              {metrics.disk.map((d) => (
                <div
                  key={d.mount}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--color-fg-dim)",
                    marginBottom: "var(--space-1)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <span>{d.mount}</span>
                  <span>
                    {formatBytes(d.used_bytes)} / {formatBytes(d.total_bytes)} ({d.percent}%)
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Top processes by CPU */}
          {metrics.processes?.top_cpu && metrics.processes.top_cpu.length > 0 && (
            <div style={{ marginBottom: "var(--space-3)" }}>
              <h4
                style={{
                  fontSize: "var(--font-size-xs)",
                  fontWeight: "var(--font-weight-medium)",
                  color: "var(--color-fg-dim)",
                  textTransform: "uppercase" as const,
                  letterSpacing: "var(--tracking-wide)",
                  marginBottom: "var(--space-2)",
                }}
              >
                Top Processes (CPU)
              </h4>
              {metrics.processes.top_cpu.slice(0, 10).map((p) => (
                <div
                  key={p.pid}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--color-fg-dim)",
                    marginBottom: "var(--space-1)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.name}
                  </span>
                  <span style={{ marginLeft: "var(--space-2)" }}>
                    {p.cpu_percent.toFixed(1)}% CPU
                  </span>
                  <span style={{ marginLeft: "var(--space-2)" }}>
                    {p.ram_percent.toFixed(1)}% RAM
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Top processes by RAM */}
          {metrics.processes?.top_ram && metrics.processes.top_ram.length > 0 && (
            <div>
              <h4
                style={{
                  fontSize: "var(--font-size-xs)",
                  fontWeight: "var(--font-weight-medium)",
                  color: "var(--color-fg-dim)",
                  textTransform: "uppercase" as const,
                  letterSpacing: "var(--tracking-wide)",
                  marginBottom: "var(--space-2)",
                }}
              >
                Top Processes (RAM)
              </h4>
              {metrics.processes.top_ram.slice(0, 10).map((p) => (
                <div
                  key={p.pid}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--color-fg-dim)",
                    marginBottom: "var(--space-1)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.name}
                  </span>
                  <span style={{ marginLeft: "var(--space-2)" }}>
                    {p.ram_percent.toFixed(1)}% RAM
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
