"use client";

import { useState } from "react";

import type { AgentRestClient } from "~/lib";

import { theme } from "./theme";

/**
 * "New session" action for the home view (task 3.5). Collects a project label
 * and a working-directory path, then calls `POST /session/start` via the REST
 * transport. The agent spawns a Claude Code session in a tmux window and
 * persists a row; the parent's `pollSessions` surfaces the new session on the
 * next tick (so we just clear the form + report success).
 */
export function NewSessionForm({
  client,
  onStarted,
}: {
  client: AgentRestClient;
  onStarted: () => void;
}) {
  const [project, setProject] = useState("");
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canSubmit = project.trim() !== "" && path.trim() !== "" && !pending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await client.startSession({
        project: project.trim(),
        path: path.trim(),
      });
      setNotice(
        result.started
          ? `Started ${result.sessionName}`
          : `Created ${result.sessionName} (not yet running)`,
      );
      if (result.specLinkError) {
        setNotice((n) => `${n ?? ""} — spec link failed: ${result.specLinkError}`);
      }
      setProject("");
      setPath("");
      onStarted();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to start session",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 16,
        borderRadius: 8,
        border: `1px solid ${theme.border}`,
        background: theme.surface,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "flex-end",
        }}
      >
        <Field
          label="Project"
          value={project}
          placeholder="nexus"
          onChange={setProject}
        />
        <Field
          label="Path"
          value={path}
          placeholder="/home/you/dev/nexus"
          onChange={setPath}
          grow
        />
        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "none",
            background: canSubmit ? theme.accent : theme.border,
            color: canSubmit ? theme.bg : theme.muted,
            fontFamily: theme.mono,
            fontSize: 13,
            cursor: canSubmit ? "pointer" : "not-allowed",
            height: 34,
          }}
        >
          {pending ? "Starting…" : "New session"}
        </button>
      </div>

      <AttachByIdField />

      {error && (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: theme.closed,
            fontFamily: theme.mono,
          }}
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: theme.live,
            fontFamily: theme.mono,
          }}
        >
          {notice}
        </p>
      )}
    </form>
  );
}

function Field({
  label,
  value,
  placeholder,
  onChange,
  grow,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  grow?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        flex: grow ? 1 : undefined,
        minWidth: 140,
      }}
    >
      <span style={{ fontSize: 11, color: theme.muted, fontFamily: theme.mono }}>
        {label}
      </span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "8px 10px",
          borderRadius: 6,
          border: `1px solid ${theme.border}`,
          background: theme.bg,
          color: theme.fg,
          fontFamily: theme.mono,
          fontSize: 13,
          outline: "none",
        }}
      />
    </label>
  );
}

/**
 * Manual "attach by id" escape hatch (task 3.4): lets a user reach
 * `/attach/:session` for a session id they have out-of-band, without it being
 * in the list yet. Uses a plain form GET-navigation via window.location.
 */
function AttachByIdField() {
  const [id, setId] = useState("");
  const trimmed = id.trim();
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
      <Field label="Attach by session id" value={id} onChange={setId} grow />
      <button
        type="button"
        disabled={trimmed === ""}
        onClick={() => {
          if (trimmed !== "") {
            window.location.href = `/attach/${encodeURIComponent(trimmed)}`;
          }
        }}
        style={{
          padding: "8px 16px",
          borderRadius: 6,
          border: `1px solid ${theme.border}`,
          background: theme.bg,
          color: trimmed === "" ? theme.muted : theme.fg,
          fontFamily: theme.mono,
          fontSize: 13,
          cursor: trimmed === "" ? "not-allowed" : "pointer",
          height: 34,
        }}
      >
        Attach →
      </button>
    </div>
  );
}
