"use client";

import { useEffect, useRef, useState } from "react";

import type { RadarSource, RequestTransition } from "~/lib/agent-radar-client";
import { fetchRequests } from "~/lib/agent-radar-client";
import { theme } from "~/components/theme";

/**
 * The two expandable drawers for a radar source row (task 2.2):
 *
 * - {@link ScanLogDrawer} — renders that source's health/scan fields from the
 *   already-loaded SourceIndex data (no fetch).
 * - {@link RequestHistoryDrawer} — fetches `/requests?source=&changed_since=`
 *   on open and renders each transition (title, old -> new, timestamp). A
 *   gateway-down / feed-missing response fail-softs to `{ requests: [] }`, which
 *   we render as an explicit NAMED empty state naming the unavailable feed —
 *   never a crash or an infinite spinner.
 */

/** Recent-history window: last 7 days. */
const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

const drawerStyle: React.CSSProperties = {
  margin: 0,
  padding: "12px 14px",
  borderRadius: 8,
  border: `1px solid ${theme.border}`,
  background: theme.bg,
  fontFamily: theme.mono,
  fontSize: 12,
  lineHeight: 1.6,
};

const fieldRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "space-between",
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={fieldRow}>
      <span style={{ color: theme.muted }}>{label}</span>
      <span style={{ color: theme.fg, textAlign: "right" }}>{value}</span>
    </div>
  );
}

/** Scan-log drawer — health/scan fields for the source, from loaded data. */
export function ScanLogDrawer({ source }: { source: RadarSource }) {
  return (
    <div style={drawerStyle}>
      <Field label="health" value={source.health} />
      {source.healthReason && (
        <Field
          label="reason"
          value={<span style={{ color: theme.warn }}>{source.healthReason}</span>}
        />
      )}
      <Field label="last scan" value={fmtTime(source.lastSyncAt)} />
      <Field label="items" value={source.itemCount ?? "—"} />
      <Field label="MINE" value={source.mineCount} />
      {source.producesKind && <Field label="kind" value={source.producesKind} />}
      <Field label="search" value={source.canSearch ? "yes" : "no"} />
      <Field label="stream" value={source.canStream ? "yes" : "no"} />
    </div>
  );
}

type HistoryState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "empty" }
  | { phase: "data"; transitions: RequestTransition[] };

/** Request-history drawer — fetches transitions on mount for this source. */
export function RequestHistoryDrawer({
  agentBaseUrl,
  source,
}: {
  agentBaseUrl: string;
  source: RadarSource;
}) {
  const [state, setState] = useState<HistoryState>({ phase: "loading" });
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    const controller = new AbortController();
    setState({ phase: "loading" });
    const changedSince = new Date(Date.now() - HISTORY_WINDOW_MS).toISOString();
    fetchRequests(agentBaseUrl, {
      source: source.id,
      changedSince,
      signal: controller.signal,
    })
      .then((transitions) => {
        if (id !== reqId.current) return;
        setState(
          transitions.length === 0
            ? { phase: "empty" }
            : { phase: "data", transitions },
        );
      })
      .catch((err: unknown) => {
        if (id !== reqId.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({
          phase: "error",
          message: err instanceof Error ? err.message : "request failed",
        });
      });
    return () => controller.abort();
  }, [agentBaseUrl, source.id]);

  if (state.phase === "loading") {
    return (
      <p style={{ ...drawerStyle, color: theme.muted }}>Loading request history…</p>
    );
  }

  if (state.phase === "error") {
    return (
      <p style={{ ...drawerStyle, color: theme.closed }}>
        Could not reach the agent: {state.message}
      </p>
    );
  }

  // Named empty state — the mx request store is not yet deployed, so the agent
  // fail-softs the gateway passthrough to an empty feed. Name it explicitly.
  if (state.phase === "empty") {
    return (
      <p style={{ ...drawerStyle, color: theme.muted }}>
        No request history for <strong>{source.displayName}</strong>. The mx
        request store feed is unavailable (not yet deployed) — transitions will
        appear here once it is reporting.
      </p>
    );
  }

  return (
    <ul
      style={{
        ...drawerStyle,
        listStyle: "none",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {state.transitions.map((t) => (
        <li key={t.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ color: theme.fg }}>{t.title}</span>
          <span style={{ color: theme.muted }}>
            {t.field ? `${t.field}: ` : ""}
            <span style={{ color: theme.closed }}>{t.oldValue ?? "—"}</span>
            {" -> "}
            <span style={{ color: theme.live }}>{t.newValue ?? "—"}</span>
            {"  ·  "}
            {fmtTime(t.changedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
