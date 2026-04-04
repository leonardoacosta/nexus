"use client";

import { useState } from "react";
import type { Session } from "@nexus/core";
import type { WithAgent } from "@/lib/agent-client";
import { SessionCard } from "./SessionCard";

interface ProjectGroupProps {
  projectName: string;
  sessions: WithAgent<Session>[];
}

export function ProjectGroup({ projectName, sessions }: ProjectGroupProps) {
  const [collapsed, setCollapsed] = useState(false);
  const activeCount = sessions.filter((s) => s.status === "active").length;

  return (
    <div style={{ marginBottom: "var(--space-4)" }}>
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          width: "100%",
          background: "none",
          border: "none",
          padding: "var(--space-2) 0",
          cursor: "pointer",
          color: "var(--color-fg)",
          fontSize: "var(--font-size-base)",
          fontWeight: "var(--font-weight-semibold)",
          fontFamily: "inherit",
        }}
      >
        <span
          style={{
            display: "inline-block",
            transition: "transform var(--transition-fast)",
            transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
            fontSize: "var(--font-size-xs)",
          }}
        >
          &#9660;
        </span>
        <span>{projectName}</span>
        <span
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-fg-muted)",
            fontWeight: "var(--font-weight-normal)",
          }}
        >
          {activeCount} active / {sessions.length} total
        </span>
      </button>
      {!collapsed && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: "var(--space-3)",
            paddingLeft: "var(--space-4)",
          }}
        >
          {sessions.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}
