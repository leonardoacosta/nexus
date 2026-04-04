"use client";

import { useState, useEffect, useCallback } from "react";
import { Card } from "@nexus/ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NotificationPreferences {
  soundEnabled: boolean;
  desktopNotifications: boolean;
  channels: {
    sessions: boolean;
    health: boolean;
    errors: boolean;
  };
  perProjectRules: Array<{
    project: string;
    muted: boolean;
  }>;
}

interface GeneralSettings {
  pollingIntervalMs: number;
}

const STORAGE_KEY_NOTIFICATIONS = "nexus-notification-prefs";
const STORAGE_KEY_GENERAL = "nexus-general-settings";

const DEFAULT_NOTIFICATION_PREFS: NotificationPreferences = {
  soundEnabled: true,
  desktopNotifications: true,
  channels: {
    sessions: true,
    health: true,
    errors: true,
  },
  perProjectRules: [],
};

const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  pollingIntervalMs: 5000,
};

const POLLING_OPTIONS = [
  { label: "1 second", value: 1000 },
  { label: "3 seconds", value: 3000 },
  { label: "5 seconds", value: 5000 },
  { label: "10 seconds", value: 10000 },
  { label: "30 seconds", value: 30000 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFromStorage<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = localStorage.getItem(key);
    if (stored) return JSON.parse(stored) as T;
  } catch {
    // Corrupt data — use fallback
  }
  return fallback;
}

function saveToStorage<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SettingsForm() {
  const [notifPrefs, setNotifPrefs] = useState<NotificationPreferences>(
    DEFAULT_NOTIFICATION_PREFS,
  );
  const [generalSettings, setGeneralSettings] = useState<GeneralSettings>(
    DEFAULT_GENERAL_SETTINGS,
  );
  const [saved, setSaved] = useState(false);
  const [newProjectRule, setNewProjectRule] = useState("");

  // Load from localStorage on mount
  useEffect(() => {
    setNotifPrefs(
      loadFromStorage(STORAGE_KEY_NOTIFICATIONS, DEFAULT_NOTIFICATION_PREFS),
    );
    setGeneralSettings(
      loadFromStorage(STORAGE_KEY_GENERAL, DEFAULT_GENERAL_SETTINGS),
    );
  }, []);

  const handleSave = useCallback(() => {
    saveToStorage(STORAGE_KEY_NOTIFICATIONS, notifPrefs);
    saveToStorage(STORAGE_KEY_GENERAL, generalSettings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [notifPrefs, generalSettings]);

  const toggleChannel = useCallback(
    (channel: keyof NotificationPreferences["channels"]) => {
      setNotifPrefs((prev) => ({
        ...prev,
        channels: { ...prev.channels, [channel]: !prev.channels[channel] },
      }));
    },
    [],
  );

  const addProjectRule = useCallback(() => {
    const project = newProjectRule.trim();
    if (!project) return;
    if (notifPrefs.perProjectRules.some((r) => r.project === project)) return;
    setNotifPrefs((prev) => ({
      ...prev,
      perProjectRules: [...prev.perProjectRules, { project, muted: false }],
    }));
    setNewProjectRule("");
  }, [newProjectRule, notifPrefs.perProjectRules]);

  const toggleProjectMuted = useCallback((project: string) => {
    setNotifPrefs((prev) => ({
      ...prev,
      perProjectRules: prev.perProjectRules.map((r) =>
        r.project === project ? { ...r, muted: !r.muted } : r,
      ),
    }));
  }, []);

  const removeProjectRule = useCallback((project: string) => {
    setNotifPrefs((prev) => ({
      ...prev,
      perProjectRules: prev.perProjectRules.filter((r) => r.project !== project),
    }));
  }, []);

  const labelStyle = {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-fg-muted)",
    marginBottom: "var(--space-1)",
    display: "block" as const,
  };

  const checkboxRowStyle = {
    display: "flex" as const,
    alignItems: "center" as const,
    gap: "var(--space-2)",
    marginBottom: "var(--space-2)",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      {/* Notification Preferences */}
      <Card title="Notification Preferences">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          {/* Global toggles */}
          <div>
            <div style={checkboxRowStyle}>
              <input
                type="checkbox"
                id="sound-enabled"
                data-testid="sound-enabled"
                checked={notifPrefs.soundEnabled}
                onChange={() =>
                  setNotifPrefs((prev) => ({
                    ...prev,
                    soundEnabled: !prev.soundEnabled,
                  }))
                }
              />
              <label htmlFor="sound-enabled" style={{ fontSize: "var(--font-size-sm)", color: "var(--color-fg)" }}>
                Sound notifications
              </label>
            </div>
            <div style={checkboxRowStyle}>
              <input
                type="checkbox"
                id="desktop-notifications"
                data-testid="desktop-notifications"
                checked={notifPrefs.desktopNotifications}
                onChange={() =>
                  setNotifPrefs((prev) => ({
                    ...prev,
                    desktopNotifications: !prev.desktopNotifications,
                  }))
                }
              />
              <label htmlFor="desktop-notifications" style={{ fontSize: "var(--font-size-sm)", color: "var(--color-fg)" }}>
                Desktop notifications
              </label>
            </div>
          </div>

          {/* Channel toggles */}
          <div>
            <span style={labelStyle}>Notification Channels</span>
            <div style={checkboxRowStyle}>
              <input
                type="checkbox"
                id="channel-sessions"
                data-testid="channel-sessions"
                checked={notifPrefs.channels.sessions}
                onChange={() => toggleChannel("sessions")}
              />
              <label htmlFor="channel-sessions" style={{ fontSize: "var(--font-size-sm)", color: "var(--color-fg)" }}>
                Session events
              </label>
            </div>
            <div style={checkboxRowStyle}>
              <input
                type="checkbox"
                id="channel-health"
                data-testid="channel-health"
                checked={notifPrefs.channels.health}
                onChange={() => toggleChannel("health")}
              />
              <label htmlFor="channel-health" style={{ fontSize: "var(--font-size-sm)", color: "var(--color-fg)" }}>
                Health alerts
              </label>
            </div>
            <div style={checkboxRowStyle}>
              <input
                type="checkbox"
                id="channel-errors"
                data-testid="channel-errors"
                checked={notifPrefs.channels.errors}
                onChange={() => toggleChannel("errors")}
              />
              <label htmlFor="channel-errors" style={{ fontSize: "var(--font-size-sm)", color: "var(--color-fg)" }}>
                Error alerts
              </label>
            </div>
          </div>

          {/* Per-project rules */}
          <div>
            <span style={labelStyle}>Per-Project Rules</span>
            <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
              <input
                type="text"
                data-testid="project-rule-input"
                placeholder="Project name"
                value={newProjectRule}
                onChange={(e) => setNewProjectRule(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addProjectRule();
                }}
                style={{
                  flex: 1,
                  padding: "var(--space-1) var(--space-2)",
                  fontSize: "var(--font-size-sm)",
                  background: "var(--color-surface-raised)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  color: "var(--color-fg)",
                  outline: "none",
                }}
              />
              <button
                type="button"
                data-testid="add-project-rule"
                onClick={addProjectRule}
                style={{
                  padding: "var(--space-1) var(--space-3)",
                  fontSize: "var(--font-size-xs)",
                  fontWeight: "var(--font-weight-medium)",
                  color: "var(--color-fg-dim)",
                  background: "var(--color-surface-raised)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  cursor: "pointer",
                }}
              >
                Add
              </button>
            </div>
            {notifPrefs.perProjectRules.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                {notifPrefs.perProjectRules.map((rule) => (
                  <div
                    key={rule.project}
                    data-testid="project-rule"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                      padding: "var(--space-1) var(--space-2)",
                      background: "var(--color-surface-raised)",
                      borderRadius: "var(--radius-sm)",
                      fontSize: "var(--font-size-xs)",
                    }}
                  >
                    <span style={{ flex: 1, color: "var(--color-fg)", fontFamily: "var(--font-mono)" }}>
                      {rule.project}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleProjectMuted(rule.project)}
                      style={{
                        padding: "var(--space-0_5) var(--space-2)",
                        fontSize: "var(--font-size-xs)",
                        color: rule.muted ? "var(--color-warning)" : "var(--color-success)",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      {rule.muted ? "Muted" : "Active"}
                    </button>
                    <button
                      type="button"
                      data-testid={`remove-rule-${rule.project}`}
                      onClick={() => removeProjectRule(rule.project)}
                      style={{
                        padding: "var(--space-0_5)",
                        fontSize: "var(--font-size-xs)",
                        color: "var(--color-error)",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Polling Interval */}
      <Card title="Polling Interval">
        <div>
          <span style={labelStyle}>Data refresh rate</span>
          <select
            data-testid="polling-interval"
            value={generalSettings.pollingIntervalMs}
            onChange={(e) =>
              setGeneralSettings((prev) => ({
                ...prev,
                pollingIntervalMs: parseInt(e.target.value, 10),
              }))
            }
            style={{
              width: "100%",
              padding: "var(--space-2)",
              fontSize: "var(--font-size-sm)",
              background: "var(--color-surface-raised)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              color: "var(--color-fg)",
              outline: "none",
              cursor: "pointer",
            }}
          >
            {POLLING_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {/* Keyboard Shortcuts */}
      <Card title="Keyboard Shortcuts">
        <table
          data-testid="shortcuts-table"
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "var(--font-size-sm)",
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  textAlign: "left",
                  padding: "var(--space-2) var(--space-3)",
                  color: "var(--color-fg-muted)",
                  fontSize: "var(--font-size-xs)",
                  fontWeight: "var(--font-weight-medium)",
                  textTransform: "uppercase",
                  letterSpacing: "var(--tracking-wide)",
                  borderBottom: "1px solid var(--color-border)",
                }}
              >
                Action
              </th>
              <th
                style={{
                  textAlign: "left",
                  padding: "var(--space-2) var(--space-3)",
                  color: "var(--color-fg-muted)",
                  fontSize: "var(--font-size-xs)",
                  fontWeight: "var(--font-weight-medium)",
                  textTransform: "uppercase",
                  letterSpacing: "var(--tracking-wide)",
                  borderBottom: "1px solid var(--color-border)",
                }}
              >
                Shortcut
              </th>
            </tr>
          </thead>
          <tbody>
            {[
              { action: "Open Command Palette", shortcut: "/" },
              { action: "Close Command Palette", shortcut: "Esc" },
              { action: "Navigate Results", shortcut: "Arrow Up / Arrow Down" },
              { action: "Select Session", shortcut: "Enter" },
              { action: "Toggle Interactive Mode", shortcut: "Click Toggle" },
              { action: "Disconnect Interactive", shortcut: "Click Disconnect" },
            ].map((row) => (
              <tr key={row.action}>
                <td
                  style={{
                    padding: "var(--space-2) var(--space-3)",
                    color: "var(--color-fg)",
                    borderBottom: "1px solid var(--color-border)",
                  }}
                >
                  {row.action}
                </td>
                <td
                  style={{
                    padding: "var(--space-2) var(--space-3)",
                    borderBottom: "1px solid var(--color-border)",
                  }}
                >
                  <kbd
                    style={{
                      fontSize: "var(--font-size-xs)",
                      color: "var(--color-fg-dim)",
                      background: "var(--color-surface-raised)",
                      padding: "var(--space-0_5) var(--space-1_5)",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--color-border)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {row.shortcut}
                  </kbd>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Save Button */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3)" }}>
        {saved && (
          <span
            data-testid="save-confirmation"
            style={{
              display: "flex",
              alignItems: "center",
              fontSize: "var(--font-size-sm)",
              color: "var(--color-success)",
            }}
          >
            Settings saved
          </span>
        )}
        <button
          type="button"
          data-testid="save-settings"
          onClick={handleSave}
          style={{
            padding: "var(--space-2) var(--space-6)",
            fontSize: "var(--font-size-sm)",
            fontWeight: "var(--font-weight-medium)",
            color: "var(--color-primary-fg)",
            background: "var(--color-primary)",
            border: "1px solid var(--color-primary)",
            borderRadius: "var(--radius-md)",
            cursor: "pointer",
            transition: "opacity var(--transition-fast)",
          }}
        >
          Save Settings
        </button>
      </div>
    </div>
  );
}
