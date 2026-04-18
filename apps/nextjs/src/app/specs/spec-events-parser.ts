/**
 * spec-events-parser.ts
 *
 * Pure parsing and state-transition functions for the live specs subscriber.
 * No React dependencies — safe to unit test in isolation.
 */

import type { SpecTransitionEvent, SpecEventsFrame } from "@nexus/core";
import type { ProjectSpecStatus } from "./types";

export interface ParseResult {
  success: boolean;
  data: SpecEventsFrame;
}

/**
 * Minimal runtime validator for an SSE frame payload. Structural checks
 * only — rejects obviously malformed frames, accepts the rest. Keeps the
 * client bundle free of zod so we don't have to pull it in as a direct
 * dep just for one schema.
 */
export function parseSpecEventsFrame(value: unknown): ParseResult {
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
    data: { seq: obj.seq as number, ts: obj.ts as string, events },
  };
}

/**
 * Apply a single transition to the project list. Returns a new list; does
 * not mutate its input. Callers use this to fold incoming SSE batches into
 * state without round-tripping to the server.
 */
export function applyTransition(
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
