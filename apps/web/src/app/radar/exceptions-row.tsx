"use client";

import { useEffect, useState } from "react";

import type { FleetExceptionEntry } from "~/lib/agent-radar-client";
import { FLEET_EXCEPTION_LABEL, fetchExceptions } from "~/lib/agent-radar-client";
import { theme } from "~/components/theme";

/**
 * Fleet exceptions row on /radar (task 2.3, add-fleet-exceptions-feed).
 *
 * Polls `GET /exceptions` and renders ONE section of repo/class/count/offender
 * lines. Silent-when-clean is the load-bearing rule: the component renders
 * `null` (nothing in the DOM) while loading, on error, and — crucially — when
 * the fleet is clean (`[]`). No skeleton, no empty-state placeholder; the row
 * simply does not exist until there is an exception to show. No scroll, no
 * drill-in — offender ids are text for use in a terminal.
 */

const POLL_INTERVAL_MS = 30_000;

export function FleetExceptionsRow({ agentBaseUrl }: { agentBaseUrl: string }) {
  const [entries, setEntries] = useState<FleetExceptionEntry[]>([]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const tick = async () => {
      if (stopped) return;
      try {
        const next = await fetchExceptions(agentBaseUrl, controller.signal);
        if (!stopped) setEntries(next);
      } catch {
        // Silent-when-clean extends to failure: keep the row absent rather than
        // surfacing an error state (the agent already fail-softs to []).
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

  // Silent-when-clean: no exceptions -> the row does not exist in the DOM.
  if (entries.length === 0) return null;

  const totalCount = entries.reduce((sum, e) => sum + e.count, 0);

  return (
    <section
      aria-label="Fleet exceptions"
      style={{
        marginBottom: 20,
        padding: "14px 16px",
        borderRadius: 8,
        border: `1px solid ${theme.closed}`,
        background: theme.surface,
        fontFamily: theme.mono,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <span style={{ fontSize: 13, color: theme.closed, fontWeight: 600 }}>
          Fleet exceptions
        </span>
        <span style={{ fontSize: 12, color: theme.muted }}>
          {entries.length} line{entries.length === 1 ? "" : "s"} · {totalCount}{" "}
          item{totalCount === 1 ? "" : "s"}
        </span>
      </div>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {entries.map((e) => (
          <li
            key={`${e.repo}:${e.class}`}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              fontSize: 12.5,
              lineHeight: 1.4,
            }}
          >
            <span style={{ color: theme.fg, minWidth: 88 }}>{e.repo}</span>
            <span style={{ color: theme.warn, minWidth: 132 }}>
              {FLEET_EXCEPTION_LABEL[e.class]}
            </span>
            <span style={{ color: theme.closed }}>×{e.count}</span>
            {e.offenders.length > 0 && (
              <span style={{ color: theme.muted }}>{e.offenders.join(" ")}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
