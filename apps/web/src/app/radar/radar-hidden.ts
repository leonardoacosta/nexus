/**
 * Pure hide/show persistence + row-partition logic for the Radar panel
 * (task 2.3). Extracted from `radar-panel.tsx` so the localStorage round-trip
 * and the visible/hidden/degraded derivation are unit-testable without a DOM
 * render harness — the panel imports these instead of inlining them.
 */

import type { RadarSource } from "~/lib/agent-radar-client";
import { isUnhealthy } from "~/lib/agent-radar-client";

/** localStorage key holding the JSON array of hidden source ids. */
export const HIDDEN_KEY = "nexus.radar.hiddenSources";

/** Load the persisted hidden-source id set from localStorage (SSR-safe). */
export function loadHidden(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(HIDDEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr)
      ? new Set(arr.filter((x): x is string => typeof x === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

/** Persist the hidden-source id set (best-effort; swallows quota/serialization errors). */
export function persistHidden(ids: Set<string>): void {
  try {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...ids]));
  } catch {
    // best-effort — a full/blocked store must not break the toggle
  }
}

export interface SourcePartition {
  /** Sources rendered as rows. */
  visible: RadarSource[];
  /** Sources hidden by the user (still counted, shown under "manage"). */
  hiddenSources: RadarSource[];
  hiddenCount: number;
  /** Count of degraded/down sources across the WHOLE set (not just visible). */
  degradedCount: number;
}

/** Split the source list into the render/summary buckets the panel needs. */
export function partitionSources(
  sources: RadarSource[],
  hidden: Set<string>,
): SourcePartition {
  const visible = sources.filter((s) => !hidden.has(s.id));
  const hiddenSources = sources.filter((s) => hidden.has(s.id));
  return {
    visible,
    hiddenSources,
    hiddenCount: hiddenSources.length,
    degradedCount: sources.filter((s) => isUnhealthy(s.health)).length,
  };
}
