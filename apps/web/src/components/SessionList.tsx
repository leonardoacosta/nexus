"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import type { SessionSummary } from "~/lib";
import { AgentRestClient, pollSessions } from "~/lib";

import { NewSessionForm } from "./NewSessionForm";
import { theme } from "./theme";

/**
 * Live session list for the home view (task 3.5). Polls `GET /sessions` via the
 * REST transport so the list reflects sessions started anywhere (and survives
 * reloads — state is server-persisted in tmux + the agent DB). Each row links
 * to its `/attach/:session` route; the "new session" form calls
 * `POST /session/start` and the next poll surfaces the new row.
 *
 * State machine (state-handling skill): loading -> error -> empty -> data.
 */
export function SessionList({ agentBaseUrl }: { agentBaseUrl: string }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<AgentRestClient | null>(null);

  if (!clientRef.current) {
    clientRef.current = new AgentRestClient(agentBaseUrl);
  }

  useEffect(() => {
    const client = new AgentRestClient(agentBaseUrl);
    clientRef.current = client;
    const poll = pollSessions(
      client,
      (next) => {
        setSessions(next);
        setError(null);
      },
      {
        intervalMs: 3_000,
        onError: (err) => {
          setError(
            err instanceof Error ? err.message : "Failed to reach the agent",
          );
        },
      },
    );
    return () => poll.stop();
  }, [agentBaseUrl]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <NewSessionForm
        client={clientRef.current}
        onStarted={() => {
          // The poll picks up the new row within the interval; nothing to do
          // here beyond letting it refresh. Clearing the error keeps the UI
          // from showing a stale failure after a successful start.
          setError(null);
        }}
      />

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: theme.muted,
            margin: 0,
            fontFamily: theme.mono,
          }}
        >
          Active sessions
        </h2>

        {/* error: poll failed AND we have no prior data to show */}
        {error && sessions === null ? (
          <Notice tone="closed">
            Could not reach the agent: {error}. Retrying…
          </Notice>
        ) : sessions === null ? (
          // loading
          <SkeletonRows />
        ) : sessions.length === 0 ? (
          // empty
          <Notice tone="muted">
            No active sessions. Start one above, or launch Claude Code on a
            registered agent — it will appear here automatically.
          </Notice>
        ) : (
          // data
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
            {sessions.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </ul>
        )}

        {/* a transient poll error while we still have data: show inline, keep list */}
        {error && sessions !== null && (
          <p
            style={{
              margin: 0,
              fontSize: 12,
              color: theme.warn,
              fontFamily: theme.mono,
            }}
          >
            agent unreachable ({error}) — showing last known list
          </p>
        )}
      </section>
    </div>
  );
}

function SessionRow({ session }: { session: SessionSummary }) {
  const label = session.cwd ?? session.projectId ?? session.id;
  const meta = [session.machine, session.branch, session.model]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <Link
        href={`/attach/${encodeURIComponent(session.id)}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 14px",
          borderRadius: 8,
          border: `1px solid ${theme.border}`,
          background: theme.surface,
          textDecoration: "none",
          color: theme.fg,
          fontFamily: theme.mono,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background:
              session.status === "active" ? theme.live : theme.muted,
            flexShrink: 0,
          }}
        />
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 14,
            }}
          >
            {label}
          </span>
          {meta && (
            <span style={{ fontSize: 12, color: theme.muted }}>{meta}</span>
          )}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: theme.accent }}>attach →</span>
      </Link>
    </li>
  );
}

function SkeletonRows() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 56,
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
