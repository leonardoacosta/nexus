"use client";

/**
 * SpecEventsSubscriber — rendering only.
 *
 * Network I/O: spec-events-transport.ts (useSpecEventsStream)
 * Frame parsing: spec-events-parser.ts (parseSpecEventsFrame, applyTransition)
 */

import { useMemo } from "react";
import {
  useSpecEventsStream,
  specKey,
  HIGHLIGHT_DURATION_MS,
} from "./spec-events-transport";
import type {
  ConnectionStatus,
  SpecEventsSubscriberProps,
} from "./spec-events-transport";

/** CSS string for spec-row highlight transitions. Static — no user content. */
const SPEC_ROW_CSS = `
  .spec-row {
    transition: background-color ${HIGHLIGHT_DURATION_MS}ms ease-out;
  }
  .spec-row-changed {
    background-color: var(--color-info-ghost);
  }
  @keyframes nexus-pulse {
    0% { opacity: 0.35; }
    50% { opacity: 1; }
    100% { opacity: 0.35; }
  }
  .nexus-live-dot-reconnecting {
    animation: nexus-pulse 1.2s ease-in-out infinite;
  }
`;

export function SpecEventsSubscriber({
  initialProjects,
  agentBaseUrl,
}: SpecEventsSubscriberProps) {
  const { projects, status, recentlyChanged } = useSpecEventsStream({
    initialProjects,
    agentBaseUrl,
  });

  const hasSpecs = useMemo(
    () => projects.some((p) => p.specs.length > 0),
    [projects],
  );

  return (
    <>
      {/* Scoped CSS for row-change highlight — static string, no user content */}
      <style>{SPEC_ROW_CSS}</style>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "var(--space-6)",
          gap: "var(--space-4)",
        }}
      >
        <h1
          style={{
            fontSize: "var(--font-size-2xl)",
            fontWeight: "var(--font-weight-bold)",
            color: "var(--color-fg)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Specs
        </h1>
        <LiveIndicator status={status} />
      </div>

      {!hasSpecs ? (
        <p style={{ color: "var(--color-fg-muted)" }}>
          No specs found across any projects.
        </p>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-6)",
          }}
        >
          {projects
            .filter((p) => p.specs.length > 0)
            .map((project) => (
              <div key={project.code}>
                <h2
                  style={{
                    fontSize: "var(--font-size-lg)",
                    fontWeight: "var(--font-weight-semibold)",
                    color: "var(--color-fg)",
                    marginBottom: "var(--space-3)",
                  }}
                >
                  {project.name}{" "}
                  <span
                    style={{
                      color: "var(--color-fg-muted)",
                      fontWeight: "normal",
                    }}
                  >
                    ({project.code})
                  </span>
                </h2>

                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "var(--font-size-sm)",
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        borderBottom: "1px solid var(--color-border)",
                        textAlign: "left",
                      }}
                    >
                      <th
                        style={{
                          padding: "var(--space-2) var(--space-3)",
                          color: "var(--color-fg-muted)",
                        }}
                      >
                        Name
                      </th>
                      <th
                        style={{
                          padding: "var(--space-2) var(--space-3)",
                          color: "var(--color-fg-muted)",
                        }}
                      >
                        Status
                      </th>
                      <th
                        style={{
                          padding: "var(--space-2) var(--space-3)",
                          color: "var(--color-fg-muted)",
                        }}
                      >
                        Tasks
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {project.specs.map((spec) => {
                      const key = specKey(project.code, spec.name);
                      const changed = recentlyChanged.has(key);
                      return (
                        <tr
                          key={spec.name}
                          className={
                            changed ? "spec-row spec-row-changed" : "spec-row"
                          }
                          style={{
                            borderBottom: "1px solid var(--color-border)",
                          }}
                        >
                          <td
                            style={{
                              padding: "var(--space-2) var(--space-3)",
                              color: "var(--color-fg)",
                            }}
                          >
                            {spec.name}
                          </td>
                          <td
                            style={{
                              padding: "var(--space-2) var(--space-3)",
                              color: "var(--color-fg-muted)",
                            }}
                          >
                            {spec.status}
                          </td>
                          <td
                            style={{
                              padding: "var(--space-2) var(--space-3)",
                              color: "var(--color-fg-muted)",
                            }}
                          >
                            {spec.completed_tasks}/{spec.total_tasks}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {project.beads && (
                  <div
                    style={{
                      marginTop: "var(--space-2)",
                      fontSize: "var(--font-size-xs)",
                      color: "var(--color-fg-muted)",
                    }}
                  >
                    Beads: {project.beads.open} open, {project.beads.ready} ready
                  </div>
                )}
              </div>
            ))}
        </div>
      )}
    </>
  );
}

function LiveIndicator({ status }: { status: ConnectionStatus }) {
  const isOpen = status === "open";
  const color = isOpen ? "var(--color-success)" : "var(--color-fg-muted)";
  const label = isOpen ? "live" : "reconnecting";
  const dotClass = isOpen ? "" : "nexus-live-dot-reconnecting";

  return (
    <span
      aria-live="polite"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "var(--font-size-xs)",
        fontWeight: "var(--font-weight-medium)",
        textTransform: "uppercase",
        letterSpacing: "var(--tracking-wide)",
        color,
      }}
    >
      <span
        aria-hidden="true"
        className={dotClass}
        style={{
          display: "inline-block",
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: color,
          boxShadow: isOpen ? "0 0 6px var(--color-success)" : "none",
        }}
      />
      {label}
    </span>
  );
}
