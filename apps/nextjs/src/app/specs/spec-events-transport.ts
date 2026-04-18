"use client";

/**
 * spec-events-transport.ts
 *
 * React hook that owns all network I/O for the live specs view:
 *  - fetch-based refetch of `/specs/all` with AbortController
 *  - EventSource subscription with exponential-backoff reconnect
 *
 * Returns `{ projects, status, highlightRow, recentlyChanged }` so the
 * rendering component has no direct network dependencies.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { SPEC_EVENTS_EVENT_NAME } from "@nexus/core";
import type { AllSpecsResponse, ProjectSpecStatus } from "./types";
import { parseSpecEventsFrame, applyTransition } from "./spec-events-parser";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

export interface SpecEventsSubscriberProps {
  /** Server-rendered snapshot passed from the RSC page. */
  initialProjects: ProjectSpecStatus[];
  /** Agent base URL resolved server-side so the client doesn't need to
   *  re-query the DB-backed registry. May be null when no agent exists. */
  agentBaseUrl: string | null;
}

export interface SpecEventsStreamResult {
  projects: ProjectSpecStatus[];
  status: ConnectionStatus;
  recentlyChanged: Set<string>;
}

export interface UseSpecEventsStreamOptions {
  initialProjects: ProjectSpecStatus[];
  agentBaseUrl: string | null;
}

const BACKOFF_SEQUENCE_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const HIGHLIGHT_DURATION_MS = 400;

export { HIGHLIGHT_DURATION_MS };

export function specKey(project: string, spec: string): string {
  return `${project}::${spec}`;
}

export function useSpecEventsStream({
  initialProjects,
  agentBaseUrl,
}: UseSpecEventsStreamOptions): SpecEventsStreamResult {
  const [projects, setProjects] = useState<ProjectSpecStatus[]>(initialProjects);
  const [status, setStatus] = useState<ConnectionStatus>(
    agentBaseUrl ? "connecting" : "reconnecting",
  );
  const [recentlyChanged, setRecentlyChanged] = useState<Set<string>>(
    () => new Set(),
  );

  // Refs for the long-lived reconnect loop and in-flight requests. Using
  // refs keeps EventSource handlers up-to-date without re-subscribing.
  const attemptsRef = useRef(0);
  const hasDisconnectedRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // AbortController for the in-flight refetchAll call. Replaced each time a
  // new refetch is triggered so a stale response is discarded on reconnect.
  const refetchAbortRef = useRef<AbortController | null>(null);

  /** Mark a row as recently changed; auto-clear after HIGHLIGHT_DURATION_MS. */
  const highlightRow = useCallback((project: string, spec: string) => {
    const key = specKey(project, spec);
    setRecentlyChanged((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    const prior = highlightTimersRef.current.get(key);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      setRecentlyChanged((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      highlightTimersRef.current.delete(key);
    }, HIGHLIGHT_DURATION_MS);
    highlightTimersRef.current.set(key, timer);
  }, []);

  /**
   * Refetch `/specs/all` and replace local state wholesale.
   * Aborts any prior in-flight request before starting a new one so stale
   * responses are never applied.
   */
  const refetchAll = useCallback(async () => {
    if (!agentBaseUrl) return;

    // Abort any in-flight refetch before starting a new one.
    refetchAbortRef.current?.abort();
    const controller = new AbortController();
    refetchAbortRef.current = controller;

    try {
      const res = await fetch(`${agentBaseUrl}/specs/all`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) return;
      const body = (await res.json()) as AllSpecsResponse;
      setProjects(body.projects ?? []);
    } catch (err) {
      // AbortError is expected on unmount or double-reconnect — ignore.
      // Other fetch failures are silently swallowed; next SSE event patches state.
      if (err instanceof Error && err.name === "AbortError") return;
    }
  }, [agentBaseUrl]);

  useEffect(() => {
    if (!agentBaseUrl) return;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      const idx = Math.min(
        attemptsRef.current,
        BACKOFF_SEQUENCE_MS.length - 1,
      );
      const delay = BACKOFF_SEQUENCE_MS[idx] ?? 30_000;
      attemptsRef.current += 1;
      setStatus("reconnecting");
      clearReconnectTimer();
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    const connect = () => {
      clearReconnectTimer();
      // Close any lingering socket before reopening.
      esRef.current?.close();

      const es = new EventSource(`${agentBaseUrl}/specs/events`);
      esRef.current = es;

      es.addEventListener("open", () => {
        attemptsRef.current = 0;
        setStatus("open");
        if (hasDisconnectedRef.current) {
          // One-shot reconciliation after a dropout. Abort any previous
          // in-flight refetch so we don't apply a stale response.
          void refetchAll();
        }
        hasDisconnectedRef.current = false;
      });

      es.addEventListener(SPEC_EVENTS_EVENT_NAME, (evt) => {
        const messageEvt = evt as MessageEvent;
        try {
          const json = JSON.parse(messageEvt.data);
          const parsed = parseSpecEventsFrame(json);
          if (!parsed.success) return;
          setProjects((prev) => {
            let next = prev;
            for (const event of parsed.data.events) {
              next = applyTransition(next, event);
              highlightRow(event.project, event.spec);
            }
            return next;
          });
        } catch {
          // Malformed frame — skip silently.
        }
      });

      es.addEventListener("error", () => {
        // EventSource auto-reconnects natively, but we drive backoff
        // explicitly for deterministic timing. Close + reschedule.
        hasDisconnectedRef.current = true;
        es.close();
        if (esRef.current === es) esRef.current = null;
        scheduleReconnect();
      });
    };

    connect();

    return () => {
      clearReconnectTimer();
      esRef.current?.close();
      esRef.current = null;
      // Abort any in-flight refetch so it doesn't update unmounted state.
      refetchAbortRef.current?.abort();
      refetchAbortRef.current = null;
      for (const timer of highlightTimersRef.current.values()) {
        clearTimeout(timer);
      }
      highlightTimersRef.current.clear();
    };
  }, [agentBaseUrl, highlightRow, refetchAll]);

  return { projects, status, recentlyChanged };
}
