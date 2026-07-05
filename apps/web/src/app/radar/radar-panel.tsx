"use client";

import { useCallback, useEffect, useState } from "react";

import type { RadarSource } from "~/lib/agent-radar-client";
import { fetchSources, isUnhealthy } from "~/lib/agent-radar-client";
import { theme } from "~/components/theme";

import { SourceRow } from "./source-row";

/**
 * Radar source panel (tasks 2.1 + 2.3). Fetches `GET /sources` from the agent,
 * renders one {@link SourceRow} per source, and re-polls every 30s (matching the
 * Swift Source Index view). Per-source hide/show toggles persist in localStorage;
 * hidden sources are excluded from the rows but still counted (health summary +
 * hidden chip).
 *
 * State machine (state-handling skill): loading -> error -> empty -> data.
 */

const POLL_INTERVAL_MS = 30_000;
const HIDDEN_KEY = "nexus.radar.hiddenSources";

/** Load the persisted hidden-source id set from localStorage (SSR-safe). */
function loadHidden(): Set<string> {
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

function persistHidden(ids: Set<string>): void {
  try {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...ids]));
  } catch {
    // localStorage unavailable (private mode / quota) — in-memory only.
  }
}

export function RadarPanel({ agentBaseUrl }: { agentBaseUrl: string }) {
  const [sources, setSources] = useState<RadarSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // Hydrate the persisted hidden set after mount (localStorage is client-only).
  useEffect(() => {
    setHidden(loadHidden());
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const tick = async () => {
      if (stopped) return;
      try {
        const index = await fetchSources(agentBaseUrl, controller.signal);
        if (stopped) return;
        setSources(index.sources);
        setError(null);
      } catch (err) {
        if (stopped) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to reach the agent");
      } finally {
        if (!stopped) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      }
    };
    void tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [agentBaseUrl]);

  const toggleHidden = useCallback((id: string) => {
    setHidden((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistHidden(next);
      return next;
    });
  }, []);

  // error with no prior data
  if (error && sources === null) {
    return (
      <Notice tone="closed">Could not reach the agent: {error}. Retrying…</Notice>
    );
  }
  // loading
  if (sources === null) return <SkeletonRows />;
  // empty
  if (sources.length === 0) {
    return (
      <Notice tone="muted">
        No sources reporting yet. The mx gateway aggregates each source&apos;s
        health here once it is running.
      </Notice>
    );
  }

  // data
  const visible = sources.filter((s) => !hidden.has(s.id));
  const hiddenCount = sources.length - visible.length;
  const degradedCount = sources.filter((s) => isUnhealthy(s.health)).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Chip>{sources.length} sources</Chip>
        {degradedCount > 0 && <Chip tone="warn">{degradedCount} degraded</Chip>}
        {hiddenCount > 0 && (
          <Chip tone="muted">
            {hiddenCount} hidden source{hiddenCount === 1 ? "" : "s"}
          </Chip>
        )}
      </div>

      {visible.length === 0 ? (
        <Notice tone="muted">
          All {sources.length} sources are hidden. Use the “show” buttons to
          reveal them.
        </Notice>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {visible.map((s) => (
            <SourceRow
              key={s.id}
              agentBaseUrl={agentBaseUrl}
              source={s}
              hidden={false}
              onToggleHidden={() => toggleHidden(s.id)}
            />
          ))}
        </ul>
      )}

      {hiddenCount > 0 && (
        <details>
          <summary
            style={{
              fontSize: 12,
              color: theme.muted,
              fontFamily: theme.mono,
              cursor: "pointer",
            }}
          >
            {hiddenCount} hidden — manage
          </summary>
          <ul
            style={{
              listStyle: "none",
              margin: "8px 0 0",
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {sources
              .filter((s) => hidden.has(s.id))
              .map((s) => (
                <SourceRow
                  key={s.id}
                  agentBaseUrl={agentBaseUrl}
                  source={s}
                  hidden
                  onToggleHidden={() => toggleHidden(s.id)}
                />
              ))}
          </ul>
        </details>
      )}

      {error && (
        <p style={{ margin: 0, fontSize: 12, color: theme.warn, fontFamily: theme.mono }}>
          agent unreachable ({error}) — showing last known sources
        </p>
      )}
    </div>
  );
}

function Chip({
  children,
  tone = "accent",
}: {
  children: React.ReactNode;
  tone?: "accent" | "warn" | "muted";
}) {
  const color =
    tone === "warn" ? theme.warn : tone === "muted" ? theme.muted : theme.accent;
  return (
    <span
      style={{
        padding: "3px 10px",
        borderRadius: 999,
        border: `1px solid ${theme.border}`,
        background: theme.surface,
        color,
        fontSize: 12,
        fontFamily: theme.mono,
      }}
    >
      {children}
    </span>
  );
}

function SkeletonRows() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 64,
            borderRadius: 8,
            border: `1px solid ${theme.border}`,
            background: theme.surface,
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "muted" | "closed";
}) {
  return (
    <p
      style={{
        margin: 0,
        padding: "16px",
        borderRadius: 8,
        border: `1px dashed ${theme.border}`,
        background: theme.surface,
        color: tone === "closed" ? theme.closed : theme.muted,
        fontSize: 13,
        lineHeight: 1.5,
        fontFamily: theme.mono,
      }}
    >
      {children}
    </p>
  );
}
