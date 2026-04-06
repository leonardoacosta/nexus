"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { CanonicalProject } from "@nexus/core";
import { startSession } from "@/app/actions/settings";
import { resolveAttachAgent } from "@/lib/agent-routing";

interface ProjectsTableProps {
  projects: CanonicalProject[];
}

const TH_STYLE: React.CSSProperties = {
  padding: "var(--space-2) var(--space-4)",
  fontSize: "var(--font-size-xs)",
  fontWeight: "var(--font-weight-medium)",
  letterSpacing: "var(--tracking-wide)",
  textTransform: "uppercase",
  color: "var(--color-fg-muted)",
  textAlign: "left",
  whiteSpace: "nowrap",
  borderBottom: "1px solid var(--color-border)",
  userSelect: "none",
};

export function ProjectsTable({ projects }: ProjectsTableProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const sorted = [...projects].sort((a, b) => {
    if (b.activeSessions !== a.activeSessions)
      return b.activeSessions - a.activeSessions;
    return a.name.localeCompare(b.name);
  });

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
        }}
      >
        <colgroup>
          <col style={{ width: "220px" }} />
          <col />
          <col style={{ width: "90px" }} />
          <col style={{ width: "80px" }} />
          <col style={{ width: "128px" }} />
        </colgroup>
        <thead>
          <tr>
            <th style={TH_STYLE}>Project</th>
            <th style={TH_STYLE}>Locations</th>
            <th style={{ ...TH_STYLE, textAlign: "right" }}>Active</th>
            <th style={{ ...TH_STYLE, textAlign: "right" }}>Total</th>
            <th style={{ ...TH_STYLE, textAlign: "right" }}></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              isHovered={hoveredId === project.id}
              onHover={() => setHoveredId(project.id)}
              onLeave={() => setHoveredId(null)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ProjectRowProps {
  project: CanonicalProject;
  isHovered: boolean;
  onHover: () => void;
  onLeave: () => void;
}

function ProjectRow({ project, isHovered, onHover, onLeave }: ProjectRowProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleStartSession = () => {
    setError(null);
    startTransition(async () => {
      try {
        const { agentName, isFallback } = resolveAttachAgent(project, []);
        const location = project.locations.find((l) => l.agentName === agentName);
        const path = location?.path ?? "";

        if (isFallback) {
          const primaryName =
            project.locations.find((l) => l.isPrimary)?.agentName ??
            project.primaryAgentId;
          window.alert(`Connected to ${agentName} (${primaryName} offline)`);
        }

        await startSession(agentName, project.name, path);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to start session");
      }
    });
  };

  const hasActive = project.activeSessions > 0;
  const sortedLocations = [...project.locations].sort(
    (a, b) => a.priority - b.priority,
  );

  return (
    <tr
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      style={{
        borderBottom: "1px solid var(--color-border)",
        background: isHovered
          ? "var(--color-surface-raised)"
          : "transparent",
        transition: "background var(--transition-fast)",
        cursor: "default",
      }}
    >
      {/* Project name */}
      <td
        style={{
          padding: "var(--space-3) var(--space-4)",
          verticalAlign: "middle",
        }}
      >
        <Link
          href={`/projects/${encodeURIComponent(project.name)}`}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-sm)",
            fontWeight: "var(--font-weight-medium)",
            color: isHovered ? "var(--color-primary)" : "var(--color-fg)",
            textDecoration: "none",
            transition: "color var(--transition-fast)",
            letterSpacing: "-0.01em",
          }}
        >
          {project.name}
        </Link>
        {error && (
          <p
            style={{
              margin: "var(--space-1) 0 0",
              fontSize: "var(--font-size-xs)",
              color: "var(--color-error)",
            }}
          >
            {error}
          </p>
        )}
      </td>

      {/* Locations */}
      <td
        style={{
          padding: "var(--space-3) var(--space-4)",
          verticalAlign: "middle",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: "var(--space-3)",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {sortedLocations.map((loc) => {
            const isMissing = loc.status === "missing";
            const isPrimaryActive = loc.isPrimary && loc.status === "active";

            return (
              <span
                key={loc.agentId}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  fontSize: "var(--font-size-xs)",
                  fontFamily: "var(--font-mono)",
                  color: isMissing
                    ? "var(--color-fg-ghost)"
                    : isPrimaryActive
                      ? "var(--color-fg-dim)"
                      : "var(--color-fg-muted)",
                  textDecoration: isMissing ? "line-through" : "none",
                  opacity: isMissing ? 0.5 : 1,
                }}
              >
                <span
                  style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: isMissing
                      ? "var(--color-fg-ghost)"
                      : isPrimaryActive
                        ? "var(--color-success)"
                        : "var(--color-fg-muted)",
                    boxShadow:
                      isPrimaryActive
                        ? "0 0 6px rgba(34, 197, 94, 0.6)"
                        : "none",
                  }}
                />
                {loc.agentName}
              </span>
            );
          })}
          {sortedLocations.length === 0 && (
            <span
              style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--color-fg-ghost)",
              }}
            >
              —
            </span>
          )}
        </div>
      </td>

      {/* Active sessions */}
      <td
        style={{
          padding: "var(--space-3) var(--space-4)",
          verticalAlign: "middle",
          textAlign: "right",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--font-size-sm)",
          fontWeight: hasActive
            ? "var(--font-weight-semibold)"
            : "var(--font-weight-normal)",
          color: hasActive ? "var(--color-success)" : "var(--color-fg-ghost)",
          letterSpacing: "-0.01em",
        }}
      >
        {project.activeSessions}
      </td>

      {/* Total sessions */}
      <td
        style={{
          padding: "var(--space-3) var(--space-4)",
          verticalAlign: "middle",
          textAlign: "right",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--font-size-sm)",
          color: "var(--color-fg-muted)",
          letterSpacing: "-0.01em",
        }}
      >
        {project.totalSessions}
      </td>

      {/* Actions */}
      <td
        style={{
          padding: "var(--space-3) var(--space-4)",
          verticalAlign: "middle",
          textAlign: "right",
        }}
      >
        <button
          type="button"
          onClick={handleStartSession}
          disabled={isPending}
          style={{
            padding: "var(--space-1_5) var(--space-3)",
            background: isPending
              ? "var(--color-surface-overlay)"
              : isHovered
                ? "var(--color-primary)"
                : "var(--color-surface-overlay)",
            color: isPending
              ? "var(--color-fg-ghost)"
              : isHovered
                ? "var(--color-primary-fg)"
                : "var(--color-fg-muted)",
            border: isHovered && !isPending
              ? "1px solid var(--color-primary)"
              : "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            cursor: isPending ? "not-allowed" : "pointer",
            fontSize: "var(--font-size-xs)",
            fontWeight: "var(--font-weight-medium)",
            fontFamily: "var(--font-sans)",
            whiteSpace: "nowrap",
            transition:
              "background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast)",
            opacity: isHovered || isPending ? 1 : 0,
            letterSpacing: "var(--tracking-wide)",
            textTransform: "uppercase",
          }}
          aria-label={`Start session in ${project.name}`}
        >
          {isPending ? "Starting…" : "Start"}
        </button>
      </td>
    </tr>
  );
}
