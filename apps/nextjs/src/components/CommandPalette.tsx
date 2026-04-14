"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@nexus/core";
import type { WithAgent } from "@/lib/agent-client";
import { fetchSessions } from "@/app/actions/sessions";
import { StatusDot, Badge } from "@nexus/ui";

// ---------------------------------------------------------------------------
// Fuzzy match — case-insensitive substring across multiple fields
// ---------------------------------------------------------------------------

function fuzzyMatch(
  session: WithAgent<Session>,
  query: string,
): boolean {
  const q = query.toLowerCase();
  const fields = [
    session.project ?? "",
    session.machine,
    session.agent,
    session.status,
  ];
  return fields.some((f) => f?.toLowerCase().includes(q));
}

// ---------------------------------------------------------------------------
// Result item (simplified session card)
// ---------------------------------------------------------------------------

function getStatusDotStatus(status: string): "active" | "idle" | "ended" {
  if (status === "active") return "active";
  if (status === "idle") return "idle";
  return "ended";
}

interface ResultItemProps {
  session: WithAgent<Session>;
  isSelected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}

function ResultItem({
  session,
  isSelected,
  onClick,
  onMouseEnter,
}: ResultItemProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isSelected && ref.current?.scrollIntoView) {
      ref.current.scrollIntoView({ block: "nearest" });
    }
  }, [isSelected]);

  return (
    <div
      ref={ref}
      role="option"
      aria-selected={isSelected}
      data-testid="command-palette-result"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "var(--space-3) var(--space-4)",
        cursor: "pointer",
        background: isSelected
          ? "var(--color-surface-raised)"
          : "transparent",
        transition: "background var(--transition-fast)",
      }}
    >
      <StatusDot status={getStatusDotStatus(session.status)} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "var(--font-size-sm)",
            fontWeight: "var(--font-weight-medium)",
            color: "var(--color-fg)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {session.project ?? "No project"}
        </div>
        <div
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-fg-muted)",
          }}
        >
          {session.machine} &middot; {session.status}
        </div>
      </div>
      <Badge>{session.agent}</Badge>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Command Palette
// ---------------------------------------------------------------------------

const MAX_RESULTS = 10;

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<WithAgent<Session>[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Fetch sessions when the palette opens
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    fetchSessions().then((result) => {
      if (!cancelled) {
        setSessions(result.sessions);
      }
    }).catch((err: unknown) => {
      // No Sentry available — structured console.error is the best we have.
      // TODO(sentry): Replace with Sentry.captureException(err) when Sentry is integrated.
      const message = err instanceof Error ? err.message : String(err);
      console.error("[CommandPalette] Failed to fetch sessions:", message);
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      // Focus the input after a tick so the DOM has rendered
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen]);

  // Filter sessions by query
  const filtered = query.trim()
    ? sessions.filter((s) => fuzzyMatch(s, query)).slice(0, MAX_RESULTS)
    : sessions.slice(0, MAX_RESULTS);

  // Clamp selectedIndex when filtered results change
  useEffect(() => {
    setSelectedIndex((prev) =>
      filtered.length === 0 ? 0 : Math.min(prev, filtered.length - 1),
    );
  }, [filtered.length]);

  const navigateToSession = useCallback(
    (session: WithAgent<Session>) => {
      onClose();
      router.push(`/session/${encodeURIComponent(session.id)}`);
    },
    [onClose, router],
  );

  // Keyboard handler inside the palette
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < filtered.length - 1 ? prev + 1 : 0,
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : filtered.length - 1,
          );
          break;
        case "Enter":
          e.preventDefault();
          if (filtered[selectedIndex]) {
            navigateToSession(filtered[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filtered, selectedIndex, navigateToSession, onClose],
  );

  // Click outside to dismiss
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  if (!isOpen) return null;

  return (
    <div
      ref={backdropRef}
      data-testid="command-palette-backdrop"
      onClick={handleBackdropClick}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: "var(--z-modal)",
        background: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "min(20vh, 160px)",
      }}
    >
      <div
        data-testid="command-palette"
        role="combobox"
        aria-expanded="true"
        aria-haspopup="listbox"
        onKeyDown={handleKeyDown}
        style={{
          width: "100%",
          maxWidth: 560,
          background: "var(--color-surface)",
          border: "1px solid var(--color-border-bright)",
          borderRadius: "var(--radius-xl)",
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden",
        }}
      >
        {/* Search input */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "var(--space-3) var(--space-4)",
            borderBottom: "1px solid var(--color-border)",
            gap: "var(--space-3)",
          }}
        >
          <span
            style={{
              color: "var(--color-fg-muted)",
              fontSize: "var(--font-size-sm)",
              flexShrink: 0,
            }}
          >
            /
          </span>
          <input
            ref={inputRef}
            data-testid="command-palette-input"
            type="text"
            placeholder="Search sessions..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--color-fg)",
              fontSize: "var(--font-size-base)",
              fontFamily: "var(--font-body)",
            }}
          />
          <kbd
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-fg-ghost)",
              background: "var(--color-surface-raised)",
              padding: "var(--space-0_5) var(--space-1_5)",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-border)",
              fontFamily: "var(--font-mono)",
            }}
          >
            esc
          </kbd>
        </div>

        {/* Results list */}
        <div
          role="listbox"
          data-testid="command-palette-results"
          style={{
            maxHeight: 400,
            overflowY: "auto",
          }}
        >
          {filtered.length === 0 ? (
            <div
              style={{
                padding: "var(--space-8) var(--space-4)",
                textAlign: "center",
                color: "var(--color-fg-muted)",
                fontSize: "var(--font-size-sm)",
              }}
            >
              {query.trim()
                ? "No sessions match your search"
                : "No sessions available"}
            </div>
          ) : (
            filtered.map((session, index) => (
              <ResultItem
                key={`${session.agent}-${session.id}`}
                session={session}
                isSelected={index === selectedIndex}
                onClick={() => navigateToSession(session)}
                onMouseEnter={() => setSelectedIndex(index)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
