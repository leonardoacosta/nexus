"use client";

import { useState } from "react";

import type { RadarSource } from "~/lib/agent-radar-client";
import { isUnhealthy } from "~/lib/agent-radar-client";
import { theme } from "~/components/theme";

import { RequestHistoryDrawer, ScanLogDrawer } from "./drawers";

/**
 * One radar source row (task 2.1 + 2.2). Renders name, status, last-scan time,
 * item count, MINE count, and last error. Unhealthy sources (DEGRADED /
 * NOT_SERVING) are visually distinct (colored dot + accent border + error
 * text). Clicking the row expands one of two drawers — the scan log or the
 * request history — rendered by `drawers.tsx`.
 */

const HEALTH_COLOR: Record<RadarSource["health"], string> = {
  SERVING: theme.live,
  DEGRADED: theme.warn,
  NOT_SERVING: theme.closed,
  UNKNOWN: theme.muted,
};

function fmtTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

type OpenDrawer = "none" | "scan" | "history";

export function SourceRow({
  agentBaseUrl,
  source,
  hidden,
  onToggleHidden,
}: {
  agentBaseUrl: string;
  source: RadarSource;
  hidden: boolean;
  onToggleHidden: () => void;
}) {
  const [open, setOpen] = useState<OpenDrawer>("none");
  const unhealthy = isUnhealthy(source.health);

  const toggle = (drawer: OpenDrawer) =>
    setOpen((cur) => (cur === drawer ? "none" : drawer));

  return (
    <li style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 14px",
          borderRadius: 8,
          border: `1px solid ${unhealthy ? HEALTH_COLOR[source.health] : theme.border}`,
          background: theme.surface,
          fontFamily: theme.mono,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: HEALTH_COLOR[source.health],
            flexShrink: 0,
          }}
        />
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 2 }}>
          <span style={{ fontSize: 14, color: theme.fg }}>
            {source.displayName}{" "}
            <span style={{ color: HEALTH_COLOR[source.health], fontSize: 12 }}>
              {source.health}
            </span>
          </span>
          <span style={{ fontSize: 12, color: theme.muted }}>
            last scan {fmtTime(source.lastSyncAt)} · {source.itemCount ?? "—"} items
            · {source.mineCount} MINE
          </span>
          {unhealthy && source.healthReason && (
            <span style={{ fontSize: 12, color: HEALTH_COLOR[source.health] }}>
              {source.healthReason}
            </span>
          )}
        </span>

        <span style={{ flex: 1 }} />

        <button
          type="button"
          onClick={() => toggle("scan")}
          style={btnStyle(open === "scan")}
        >
          scan log
        </button>
        <button
          type="button"
          onClick={() => toggle("history")}
          style={btnStyle(open === "history")}
        >
          history
        </button>
        <button
          type="button"
          onClick={onToggleHidden}
          style={btnStyle(false)}
          aria-pressed={hidden}
        >
          {hidden ? "show" : "hide"}
        </button>
      </div>

      {open === "scan" && <ScanLogDrawer source={source} />}
      {open === "history" && (
        <RequestHistoryDrawer agentBaseUrl={agentBaseUrl} source={source} />
      )}
    </li>
  );
}

function btnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 6,
    border: `1px solid ${active ? theme.accent : theme.border}`,
    background: active ? theme.bg : "transparent",
    color: active ? theme.accent : theme.muted,
    fontFamily: theme.mono,
    fontSize: 12,
    cursor: "pointer",
    flexShrink: 0,
  };
}
