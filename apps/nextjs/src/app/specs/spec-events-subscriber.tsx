"use client";

/**
 * SpecEventsSubscriber
 *
 * Wraps the specs table as a client component and subscribes to
 * `/specs/events` SSE so the table updates without a full page reload.
 *
 * Reconnect strategy:
 *   - Exponential backoff: 1s → 2s → 4s → 8s → 16s → cap 30s.
 *   - On each successful reconnect after a prior disconnect, the component
 *     fires a one-shot refetch of `/specs/all` and replaces local state
 *     wholesale. This reconciles any transitions that occurred during the
 *     disconnect window.
 *
 * State handling:
 *   - `status` drives the small header indicator (connected / reconnecting).
 *   - `recentlyChanged` is a transient per-row key set; rows in this set
 *     render with a highlight class that the CSS transitions to baseline
 *     over ≤400ms so operators can see which row just moved.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// -- Spec events wire types ------------------------------------------------
// Mirrors `packages/core/src/types/spec-events.ts`. Duplicated here (rather
// than imported from `@nexus/core`) because the barrel re-exports node-only
// helpers (`safeSpawn`, `expandTilde`) which trip webpack's
// UnhandledSchemeError on `node:path` / `node:os` when pulled into a client
// component. Keep this in sync with the core source of truth.

type SpecTransitionEvent =
  | { kind: "new"; project: string; spec: string }
  | {
      kind: "progress";
      project: string;
      spec: string;
      completed: number;
      total: number;
    }
  | { kind: "complete"; project: string; spec: string }
  | { kind: "archived"; project: string; spec: string };

interface SpecEventsFrame {
  seq: number;
  ts: string;
  events: SpecTransitionEvent[];
}

interface ParseResult {
  success: boolean;
  data: SpecEventsFrame;
}

/**
 * Minimal runtime validator for the SSE frame payload. Structural checks
 * only — rejects obviously malformed frames, accepts the rest. Keeps the
 * client bundle free of zod so we don't have to pull it in as a direct
 * dep just for one schema.
 */
function parseSpecEventsFrame(value: unknown): ParseResult {
  const empty: SpecEventsFrame = { seq: 0, ts: "", events: [] };
  if (!value || typeof value !== "object") return { success: false, data: empty };
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.seq !== "number" ||
    !Number.isFinite(obj.seq) ||
    typeof obj.ts !== "string" ||
    !Array.isArray(obj.events)
  ) {
    return { success: false, data: empty };
  }
  const events: SpecTransitionEvent[] = [];
  for (const raw of obj.events) {
    if (!raw || typeof raw !== "object") return { success: false, data: empty };
    const ev = raw as Record<string, unknown>;
    if (
      typeof ev.kind !== "string" ||
      typeof ev.project !== "string" ||
      typeof ev.spec !== "string"
    ) {
      return { success: false, data: empty };
    }
    switch (ev.kind) {
      case "new":
      case "complete":
      case "archived":
        events.push({
          kind: ev.kind,
          project: ev.project,
          spec: ev.spec,
        });
        break;
      case "progress":
        if (
          typeof ev.completed !== "number" ||
          typeof ev.total !== "number"
        ) {
          return { success: false, data: empty };
        }
        events.push({
          kind: "progress",
          project: ev.project,
          spec: ev.spec,
          completed: ev.completed,
          total: ev.total,
        });
        break;
      default:
        return { success: false, data: empty };
    }
  }
  return {
    success: true,
    data: { seq: obj.seq, ts: obj.ts, events },
  };
}

const SPEC_EVENTS_EVENT_NAME = "spec-transition" as const;

import type { AllSpecsResponse, ProjectSpecStatus } from "./types";

const BACKOFF_SEQUENCE_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const HIGHLIGHT_DURATION_MS = 400;

type ConnectionStatus = "connecting" | "open" | "reconnecting";

interface SpecEventsSubscriberProps {
  /** Server-rendered snapshot passed from the RSC page. */
  initialProjects: ProjectSpecStatus[];
  /** Agent base URL resolved server-side so the client doesn't need to
   *  re-query the DB-backed registry. May be null when no agent exists. */
  agentBaseUrl: string | null;
}

function specKey(project: string, spec: string): string {
  return `${project}::${spec}`;
}

/**
 * Apply a single transition to the project list. Returns a new list; does
 * not mutate its input. Callers use this to fold incoming SSE batches into
 * state without round-tripping to the server.
 */
function applyTransition(
  projects: ProjectSpecStatus[],
  event: SpecTransitionEvent,
): ProjectSpecStatus[] {
  return projects.map((proj) => {
    if (proj.code !== event.project) return proj;

    switch (event.kind) {
      case "archived": {
        return {
          ...proj,
          specs: proj.specs.filter((s) => s.name !== event.spec),
        };
      }
      case "new": {
        // If the spec already exists, leave untouched; `progress` will
        // refresh the counts. Otherwise insert a placeholder row that
        // will fill in on the next refetch.
        if (proj.specs.some((s) => s.name === event.spec)) return proj;
        return {
          ...proj,
          specs: [
            ...proj.specs,
            {
              name: event.spec,
              status: "pending",
              completed_tasks: 0,
              total_tasks: 0,
              last_modified: null,
            },
          ],
        };
      }
      case "progress": {
        return {
          ...proj,
          specs: proj.specs.map((s) =>
            s.name === event.spec
              ? {
                  ...s,
                  completed_tasks: event.completed,
                  total_tasks: event.total,
                }
              : s,
          ),
        };
      }
      case "complete": {
        return {
          ...proj,
          specs: proj.specs.map((s) =>
            s.name === event.spec ? { ...s, status: "complete" } : s,
          ),
        };
      }
    }
  });
}

export function SpecEventsSubscriber({
  initialProjects,
  agentBaseUrl,
}: SpecEventsSubscriberProps) {
  const [projects, setProjects] = useState<ProjectSpecStatus[]>(initialProjects);
  const [status, setStatus] = useState<ConnectionStatus>(
    agentBaseUrl ? "connecting" : "reconnecting",
  );
  const [recentlyChanged, setRecentlyChanged] = useState<Set<string>>(
    () => new Set(),
  );

  // Refs used by the long-lived reconnect loop. Storing them in refs means
  // the EventSource handlers see the latest values without re-subscribing.
  const attemptsRef = useRef(0);
  const hasDisconnectedRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  /** Mark a row as recently changed; auto-clear after HIGHLIGHT_DURATION_MS. */
  const highlightRow = useCallback((project: string, spec: string) => {
    const key = specKey(project, spec);
    setRecentlyChanged((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    const prior = highlightTimersRef.current.get(key);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      setRecentlyChanged((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      highlightTimersRef.current.delete(key);
    }, HIGHLIGHT_DURATION_MS);
    highlightTimersRef.current.set(key, timer);
  }, []);

  /** Refetch `/specs/all` and replace local state wholesale. */
  const refetchAll = useCallback(async () => {
    if (!agentBaseUrl) return;
    try {
      const res = await fetch(`${agentBaseUrl}/specs/all`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const body = (await res.json()) as AllSpecsResponse;
      setProjects(body.projects ?? []);
    } catch {
      // Silently swallow — the next SSE event will patch state.
    }
  }, [agentBaseUrl]);

  useEffect(() => {
    if (!agentBaseUrl) return;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      const idx = Math.min(
        attemptsRef.current,
        BACKOFF_SEQUENCE_MS.length - 1,
      );
      const delay = BACKOFF_SEQUENCE_MS[idx] ?? 30_000;
      attemptsRef.current += 1;
      setStatus("reconnecting");
      clearReconnectTimer();
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    const connect = () => {
      clearReconnectTimer();
      // Close any lingering socket before reopening.
      esRef.current?.close();

      const es = new EventSource(`${agentBaseUrl}/specs/events`);
      esRef.current = es;

      es.addEventListener("open", () => {
        attemptsRef.current = 0;
        setStatus("open");
        if (hasDisconnectedRef.current) {
          // One-shot reconciliation after a dropout — don't await; local
          // patches keep flowing in parallel and the whole-list replace
          // will happen on resolution.
          void refetchAll();
        }
        hasDisconnectedRef.current = false;
      });

      es.addEventListener(SPEC_EVENTS_EVENT_NAME, (evt) => {
        const messageEvt = evt as MessageEvent;
        try {
          const json = JSON.parse(messageEvt.data);
          const parsed = parseSpecEventsFrame(json);
          if (!parsed.success) return;
          setProjects((prev) => {
            let next = prev;
            for (const event of parsed.data.events) {
              next = applyTransition(next, event);
              highlightRow(event.project, event.spec);
            }
            return next;
          });
        } catch {
          // Malformed frame — skip silently.
        }
      });

      es.addEventListener("error", () => {
        // EventSource auto-reconnects, but we drive backoff explicitly so
        // the user sees deterministic timing. Close + reschedule.
        hasDisconnectedRef.current = true;
        es.close();
        if (esRef.current === es) esRef.current = null;
        scheduleReconnect();
      });
    };

    connect();

    return () => {
      clearReconnectTimer();
      esRef.current?.close();
      esRef.current = null;
      for (const timer of highlightTimersRef.current.values()) {
        clearTimeout(timer);
      }
      highlightTimersRef.current.clear();
    };
  }, [agentBaseUrl, highlightRow, refetchAll]);

  const hasSpecs = useMemo(
    () => projects.some((p) => p.specs.length > 0),
    [projects],
  );

  return (
    <>
      {/* Scoped CSS for the row-change highlight — ≤400ms fade */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
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
          `,
        }}
      />

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
