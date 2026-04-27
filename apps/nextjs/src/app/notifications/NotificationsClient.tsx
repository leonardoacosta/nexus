"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@nexus/ui";
import {
  replayNotification,
  updateNotificationSettings,
  type DuckingMode,
  type NotificationRow,
  type NotificationSettingsPatch,
  type NotificationSettingsWire,
} from "@/app/actions/notifications";
import type {
  Reachability,
  ReachabilityAttempt,
} from "@/lib/agent-reachability";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_ROWS = 200;
const TOAST_DURATION_MS = 3_000;

const DUCKING_MODES: { value: DuckingMode; label: string }[] = [
  { value: "full", label: "Full" },
  { value: "half", label: "Half" },
  { value: "mute", label: "Mute" },
];

// Statuses for which replay is meaningless. The proposal calls out
// `expired` and `suppressed`; we also defensively block empty/unknown.
const REPLAY_DISABLED_STATUSES = new Set(["expired", "suppressed"]);

// ── Props ────────────────────────────────────────────────────────────────────

interface NotificationsClientProps {
  initialSettings: NotificationSettingsWire | null;
  initialRows: NotificationRow[];
  /**
   * Coarse yes/no flag — kept for the existing logic that uses it to gate
   * `settingsDisabled`, the SSE subscription, and other yes/no decisions.
   * Banner copy is driven by `reachability` instead.
   */
  agentReachable: boolean;
  /**
   * Full reachability classification. Drives the banner copy switch — each
   * failure mode (`no-agent`, `all-failed`, `stale-binary`) gets its own
   * actionable message. When `reachability.ok === true`, the banner is
   * hidden regardless of `agentReachable` and a small "using <agent.name>"
   * indicator is rendered when `reachability.failover === true`.
   * See `bannerCopyForReachability` below.
   */
  reachability: Reachability;
}

/**
 * Describe a single `ReachabilityAttempt` outcome in human-readable form
 * for use in the terminal sentence of the banner. The "ok" branch should
 * never appear in a failure banner but is defended for exhaustiveness.
 */
function describeAttempt(a: ReachabilityAttempt): string {
  switch (a.outcome) {
    case "ok":
      return "responded ok";
    case "timeout":
      return "timed out";
    case "http-error":
      return `returned HTTP ${a.status}`;
    case "bad-shape":
      return "returned invalid /version payload";
    case "stale-binary":
      return `is stale (missing ${a.missing.join(", ")})`;
  }
}

/**
 * Map a `Reachability` failure variant to user-facing banner copy.
 *
 * Returns "" when the agent is reachable — the caller suppresses the banner
 * via the `reachability.ok` guard. Failure copy names the LAST attempted
 * agent's host:port so the user can act on the terminal failure.
 */
function bannerCopyForReachability(r: Reachability): string {
  if (r.ok) return "";
  switch (r.reason) {
    case "no-agent":
      return "No agent registered — add one in Agents settings.";
    case "all-failed": {
      const lastAttempt = r.attempts[r.attempts.length - 1];
      const desc = lastAttempt
        ? describeAttempt(lastAttempt)
        : "could not be reached";
      return `All agents unreachable — last attempt: ${r.agent.name} at ${r.agent.host}:${r.agent.port} ${desc}.`;
    }
    case "stale-binary":
      return `Agent ${r.agent.name} build ${r.build.sha} is missing ${r.missing.join(", ")} — rebuild the agent.`;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface BadgeColors {
  bg: string;
  fg: string;
}

function statusBadgeColors(status: string): BadgeColors {
  switch (status) {
    case "delivered":
      return {
        bg: "var(--color-success-ghost)",
        fg: "var(--color-success)",
      };
    case "queued":
      return {
        bg: "var(--color-warning-ghost)",
        fg: "var(--color-warning)",
      };
    case "expired":
    case "suppressed":
      return {
        bg: "var(--color-surface-raised)",
        fg: "var(--color-fg-muted)",
      };
    case "failed":
      return {
        bg: "var(--color-error-ghost)",
        fg: "var(--color-error)",
      };
    default:
      return {
        bg: "var(--color-surface-raised)",
        fg: "var(--color-fg-dim)",
      };
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // HH:mm:ss in the viewer's locale — compact for the table.
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// SSE envelope shape — mirrors `LifecycleEnvelope` in the agent.
interface LifecycleEnvelope<TPayload = unknown> {
  event: string;
  payload: TPayload;
  source?: string;
  seq?: number;
  ts?: string;
  origin?: string;
}

// Payload shape mirrors `NotificationFiredPayload` in apps/agent.
interface NotificationFiredPayload {
  id: string;
  title: string;
  body: string;
  channel: string;
  project?: string;
}

// Payload shape mirrors `SettingsChangedPayload` in apps/agent.
interface SettingsChangedPayload {
  ttsEnabled: boolean;
  bannerEnabled: boolean;
  duckingMode: DuckingMode;
}

function isNotificationFired(
  env: LifecycleEnvelope,
): env is LifecycleEnvelope<NotificationFiredPayload> {
  if (env.event !== "NotificationFired") return false;
  const p = env.payload as Partial<NotificationFiredPayload> | undefined;
  return (
    !!p &&
    typeof p.id === "string" &&
    typeof p.title === "string" &&
    typeof p.body === "string" &&
    typeof p.channel === "string"
  );
}

function isSettingsChanged(
  env: LifecycleEnvelope,
): env is LifecycleEnvelope<SettingsChangedPayload> {
  if (env.event !== "SettingsChanged") return false;
  const p = env.payload as Partial<SettingsChangedPayload> | undefined;
  return (
    !!p &&
    typeof p.ttsEnabled === "boolean" &&
    typeof p.bannerEnabled === "boolean" &&
    (p.duckingMode === "full" ||
      p.duckingMode === "half" ||
      p.duckingMode === "mute")
  );
}

function envelopeToRow(
  env: LifecycleEnvelope<NotificationFiredPayload>,
): NotificationRow {
  return {
    id: env.payload.id,
    channel: env.payload.channel,
    title: env.payload.title,
    body: env.payload.body,
    project: env.payload.project ?? null,
    agentId: null,
    priority: "normal",
    status: "delivered",
    createdAt: env.ts ?? new Date().toISOString(),
    sentAt: env.ts ?? null,
  };
}

// ── Reusable styles ──────────────────────────────────────────────────────────

const switchTrack = (checked: boolean): React.CSSProperties => ({
  position: "relative",
  width: 36,
  height: 20,
  background: checked ? "var(--color-primary)" : "var(--color-surface-raised)",
  border: `1px solid ${
    checked ? "var(--color-primary)" : "var(--color-border)"
  }`,
  borderRadius: "var(--radius-full)",
  cursor: "pointer",
  padding: 0,
  transition: "background var(--transition-fast)",
});

const switchThumb = (checked: boolean): React.CSSProperties => ({
  position: "absolute",
  top: 1,
  left: checked ? 17 : 1,
  width: 16,
  height: 16,
  background: "#FFFFFF",
  borderRadius: "var(--radius-full)",
  transition: "left var(--transition-fast)",
});

const radioPillBase: React.CSSProperties = {
  padding: "var(--space-1) var(--space-3)",
  fontSize: "var(--font-size-xs)",
  fontWeight: "var(--font-weight-medium)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-border)",
  background: "var(--color-surface-raised)",
  color: "var(--color-fg-dim)",
  cursor: "pointer",
  transition: "background var(--transition-fast), color var(--transition-fast)",
};

const radioPillActive: React.CSSProperties = {
  ...radioPillBase,
  background: "var(--color-primary-ghost)",
  color: "var(--color-primary)",
  borderColor: "var(--color-primary)",
};

const cellBase: React.CSSProperties = {
  padding: "var(--space-1) var(--space-3)",
  borderBottom: "1px solid var(--color-border)",
  fontSize: "var(--font-size-xs)",
  color: "var(--color-fg)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const headerCell: React.CSSProperties = {
  textAlign: "left",
  padding: "var(--space-2) var(--space-3)",
  color: "var(--color-fg-muted)",
  fontSize: "var(--font-size-xs)",
  fontWeight: "var(--font-weight-medium)",
  textTransform: "uppercase",
  letterSpacing: "var(--tracking-wide)",
  borderBottom: "1px solid var(--color-border)",
};

// ── Component ────────────────────────────────────────────────────────────────

export function NotificationsClient({
  initialSettings,
  initialRows,
  agentReachable,
  reachability,
}: NotificationsClientProps) {
  // Settings state. `null` is the "agent unreachable / no row" case — we
  // still render the controls so the user has visual context, but disable
  // them so they can't accidentally PATCH a 404.
  const [settings, setSettings] = useState<NotificationSettingsWire | null>(
    initialSettings,
  );
  const [pending, setPending] = useState<NotificationSettingsPatch | null>(
    null,
  );

  // Notification rows — capped at MAX_ROWS to bound memory.
  const [rows, setRows] = useState<NotificationRow[]>(initialRows);

  // In-flight replay tracker so we can disable the row's button while the
  // server action resolves (prevents double-fires).
  const [replaying, setReplaying] = useState<Set<string>>(() => new Set());

  // Toasts — non-blocking error indicator. We keep a tiny in-memory queue so
  // a quick burst of failures doesn't squash earlier messages.
  const [toasts, setToasts] = useState<{ id: string; message: string }[]>([]);
  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const pushToast = useCallback((message: string) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, message }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      toastTimersRef.current.delete(id);
    }, TOAST_DURATION_MS);
    toastTimersRef.current.set(id, timer);
  }, []);

  // Cleanup any pending toast timers on unmount so React doesn't yell about
  // setState-after-unmount in tests.
  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // ── Optimistic mutation helper ────────────────────────────────────────────
  // We use a manual optimistic pattern (vs `useOptimistic`) because the
  // surrounding state is a regular `useState` and rollback-on-failure is
  // explicit — this stays readable and avoids the transition-pending dance.
  const applyPatch = useCallback(
    async (patch: NotificationSettingsPatch) => {
      if (!settings) return;
      const before = settings;
      const optimistic: NotificationSettingsWire = {
        ...before,
        ...(patch.tts_enabled !== undefined
          ? { tts_enabled: patch.tts_enabled }
          : {}),
        ...(patch.banner_enabled !== undefined
          ? { banner_enabled: patch.banner_enabled }
          : {}),
        ...(patch.ducking_mode !== undefined
          ? { ducking_mode: patch.ducking_mode }
          : {}),
        updated_at: new Date().toISOString(),
      };
      setSettings(optimistic);
      setPending(patch);
      try {
        const next = await updateNotificationSettings(patch);
        setSettings(next);
      } catch (err) {
        setSettings(before);
        const msg = err instanceof Error ? err.message : String(err);
        pushToast(`Could not update settings: ${msg}`);
      } finally {
        setPending(null);
      }
    },
    [settings, pushToast],
  );

  const onToggleTts = useCallback(() => {
    if (!settings) return;
    void applyPatch({ tts_enabled: !settings.tts_enabled });
  }, [settings, applyPatch]);

  const onToggleBanner = useCallback(() => {
    if (!settings) return;
    void applyPatch({ banner_enabled: !settings.banner_enabled });
  }, [settings, applyPatch]);

  const onSelectDucking = useCallback(
    (mode: DuckingMode) => {
      if (!settings || settings.ducking_mode === mode) return;
      void applyPatch({ ducking_mode: mode });
    },
    [settings, applyPatch],
  );

  // ── SSE subscription ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!agentReachable) return;
    // Same-origin proxy to the agent's SSE stream.
    const es = new EventSource("/api/notifications/stream");

    const onNotificationFired = (evt: MessageEvent) => {
      try {
        const env = JSON.parse(evt.data) as LifecycleEnvelope;
        if (!isNotificationFired(env)) return;
        const row = envelopeToRow(env);
        setRows((prev) => {
          // Dedup against the current head — replay from the same id within
          // a tick should not double-render.
          if (prev.length > 0 && prev[0]!.id === row.id) return prev;
          const next = [row, ...prev];
          return next.length > MAX_ROWS ? next.slice(0, MAX_ROWS) : next;
        });
      } catch {
        // Malformed frame — skip silently.
      }
    };

    const onSettingsChanged = (evt: MessageEvent) => {
      try {
        const env = JSON.parse(evt.data) as LifecycleEnvelope;
        if (!isSettingsChanged(env)) return;
        setSettings((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            tts_enabled: env.payload.ttsEnabled,
            banner_enabled: env.payload.bannerEnabled,
            ducking_mode: env.payload.duckingMode,
            updated_at: env.ts ?? new Date().toISOString(),
          };
        });
      } catch {
        // Malformed frame — skip silently.
      }
    };

    es.addEventListener("NotificationFired", onNotificationFired);
    es.addEventListener("SettingsChanged", onSettingsChanged);

    return () => {
      es.removeEventListener("NotificationFired", onNotificationFired);
      es.removeEventListener("SettingsChanged", onSettingsChanged);
      es.close();
    };
  }, [agentReachable]);

  // ── Replay handler ────────────────────────────────────────────────────────
  const onReplay = useCallback(
    async (row: NotificationRow) => {
      if (REPLAY_DISABLED_STATUSES.has(row.status)) return;
      if (replaying.has(row.id)) return;
      setReplaying((prev) => {
        const next = new Set(prev);
        next.add(row.id);
        return next;
      });
      const result = await replayNotification({
        channel: row.channel,
        title: row.title,
        body: row.body,
        project: row.project,
        priority: row.priority,
      });
      setReplaying((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
      if (!result.ok) {
        pushToast(`Replay failed: ${result.error}`);
      }
    },
    [replaying, pushToast],
  );

  // ── Derived ──────────────────────────────────────────────────────────────
  const settingsDisabled = !settings;
  const ttsChecked = settings?.tts_enabled ?? true;
  const bannerChecked = settings?.banner_enabled ?? true;
  const duckingActive: DuckingMode = settings?.ducking_mode ?? "full";

  const visibleRows = useMemo(() => rows.slice(0, MAX_ROWS), [rows]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
    >
      {/* Settings strip — height-bounded to ≤120px per the proposal. */}
      <div style={{ maxHeight: 120 }}>
        <Card>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-6)",
              flexWrap: "wrap",
              minHeight: 56,
            }}
          >
            {/* TTS toggle */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
              }}
            >
              <span
                style={{
                  fontSize: "var(--font-size-sm)",
                  color: "var(--color-fg)",
                  fontWeight: "var(--font-weight-medium)",
                }}
              >
                TTS
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={ttsChecked}
                aria-label="TTS enabled"
                data-testid="toggle-tts"
                disabled={settingsDisabled || pending?.tts_enabled !== undefined}
                onClick={onToggleTts}
                style={switchTrack(ttsChecked)}
              >
                <span style={switchThumb(ttsChecked)} />
              </button>
            </div>

            {/* Banner toggle */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
              }}
            >
              <span
                style={{
                  fontSize: "var(--font-size-sm)",
                  color: "var(--color-fg)",
                  fontWeight: "var(--font-weight-medium)",
                }}
              >
                Banners
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={bannerChecked}
                aria-label="Banners enabled"
                data-testid="toggle-banner"
                disabled={
                  settingsDisabled || pending?.banner_enabled !== undefined
                }
                onClick={onToggleBanner}
                style={switchTrack(bannerChecked)}
              >
                <span style={switchThumb(bannerChecked)} />
              </button>
            </div>

            {/* Ducking radio group */}
            <div
              role="radiogroup"
              aria-label="Audio ducking"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
              }}
            >
              <span
                style={{
                  fontSize: "var(--font-size-sm)",
                  color: "var(--color-fg)",
                  fontWeight: "var(--font-weight-medium)",
                }}
              >
                Ducking
              </span>
              <div style={{ display: "flex", gap: "var(--space-1)" }}>
                {DUCKING_MODES.map((mode) => {
                  const active = duckingActive === mode.value;
                  return (
                    <button
                      key={mode.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      data-testid={`ducking-${mode.value}`}
                      disabled={
                        settingsDisabled ||
                        pending?.ducking_mode !== undefined
                      }
                      onClick={() => onSelectDucking(mode.value)}
                      style={active ? radioPillActive : radioPillBase}
                    >
                      {mode.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/*
             * Failover indicator: shown when the agent IS reachable but a
             * non-first agent in DB order answered. Informational style
             * (muted text), not error/warning. Tested via
             * `data-testid="agent-failover-indicator"`.
             */}
            {reachability.ok && reachability.failover && (
              <span
                data-testid="agent-failover-indicator"
                style={{
                  marginLeft: "auto",
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-fg-muted)",
                }}
              >
                using {reachability.agent.name}
              </span>
            )}
            {/*
             * Unreachable banner: rendered when the reachability classifier
             * could not get a healthy responder out of the registry. Copy
             * names the LAST attempted agent's host:port and the terminal
             * failure mode (timeout / HTTP / stale).
             */}
            {!reachability.ok && (
              <span
                data-testid="agent-banner"
                style={{
                  marginLeft: "auto",
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-warning)",
                }}
              >
                {bannerCopyForReachability(reachability)}
              </span>
            )}
          </div>
        </Card>
      </div>

      {/* Notifications table */}
      <Card>
        {visibleRows.length === 0 ? (
          <p
            style={{
              padding: "var(--space-8) var(--space-4)",
              textAlign: "center",
              color: "var(--color-fg-muted)",
              fontSize: "var(--font-size-sm)",
            }}
          >
            No notifications yet.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              data-testid="notifications-table"
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "var(--font-size-xs)",
                tableLayout: "fixed",
              }}
            >
              <colgroup>
                <col style={{ width: 80 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: "20%" }} />
                <col />
                <col style={{ width: 90 }} />
                <col style={{ width: 40 }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={headerCell}>Time</th>
                  <th style={headerCell}>Channel</th>
                  <th style={headerCell}>Project</th>
                  <th style={headerCell}>Title</th>
                  <th style={headerCell}>Body</th>
                  <th style={headerCell}>Status</th>
                  <th style={headerCell} aria-label="Replay" />
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const colors = statusBadgeColors(row.status);
                  const replayDisabled =
                    REPLAY_DISABLED_STATUSES.has(row.status) ||
                    replaying.has(row.id);
                  return (
                    <tr
                      key={row.id}
                      data-testid="notification-row"
                      style={{ height: 36 }}
                    >
                      <td
                        style={{
                          ...cellBase,
                          color: "var(--color-fg-muted)",
                          fontFamily: "var(--font-mono)",
                        }}
                        suppressHydrationWarning
                      >
                        {formatTime(row.createdAt)}
                      </td>
                      <td
                        style={{ ...cellBase, color: "var(--color-fg-dim)" }}
                      >
                        {row.channel}
                      </td>
                      <td
                        style={{
                          ...cellBase,
                          color: "var(--color-fg-dim)",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {row.project ?? "—"}
                      </td>
                      <td style={cellBase}>{row.title}</td>
                      <td style={{ ...cellBase, color: "var(--color-fg-dim)" }}>
                        {row.body}
                      </td>
                      <td style={cellBase}>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            padding: "var(--space-0_5) var(--space-2)",
                            fontSize: "var(--font-size-xs)",
                            fontWeight: "var(--font-weight-medium)",
                            lineHeight: "var(--line-height-tight)",
                            borderRadius: "var(--radius-full)",
                            background: colors.bg,
                            color: colors.fg,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td
                        style={{ ...cellBase, padding: 0, textAlign: "center" }}
                      >
                        <button
                          type="button"
                          aria-label="Replay notification"
                          data-testid="replay-button"
                          disabled={replayDisabled}
                          onClick={() => void onReplay(row)}
                          style={{
                            background: "transparent",
                            border: "none",
                            color: replayDisabled
                              ? "var(--color-fg-ghost)"
                              : "var(--color-primary)",
                            cursor: replayDisabled ? "not-allowed" : "pointer",
                            fontSize: "var(--font-size-sm)",
                            padding: "var(--space-1) var(--space-2)",
                          }}
                        >
                          {"▶"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Toasts — non-modal, fixed corner so they don't fight the table. */}
      {toasts.length > 0 && (
        <div
          style={{
            position: "fixed",
            bottom: "var(--space-4)",
            right: "var(--space-4)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
            zIndex: 50,
            maxWidth: 360,
          }}
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              data-testid="toast"
              style={{
                padding: "var(--space-2) var(--space-3)",
                background: "var(--color-surface-overlay)",
                border: "1px solid var(--color-error)",
                borderRadius: "var(--radius-md)",
                color: "var(--color-fg)",
                fontSize: "var(--font-size-sm)",
                boxShadow: "var(--shadow-md)",
              }}
            >
              {t.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
