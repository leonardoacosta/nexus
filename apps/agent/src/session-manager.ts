import { hostname } from "node:os";
import { logger } from "@nexus/core";
import type { Session, WatcherEvent } from "@nexus/core";

const IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // 60 seconds

export interface SessionManager {
  handleWatcherEvent(event: WatcherEvent): void;
  getAll(): Session[];
  getActive(): Session[];
  getById(id: string): Session | null;
  sweepIdle(): void;
  /** Stop the periodic sweep timer. */
  stop(): void;
}

export function createSessionManager(): SessionManager {
  const sessions = new Map<string, Session>();
  const machine = hostname();

  const sweepTimer = setInterval(() => {
    sweepIdle();
  }, SWEEP_INTERVAL_MS);

  function handleWatcherEvent(event: WatcherEvent): void {
    switch (event.type) {
      case "session_start": {
        const now = new Date().toISOString();
        const session: Session = {
          id: event.session_id,
          pid: 0,
          project: event.project || null,
          machine,
          cwd: event.path,
          branch: null,
          startedAt: now,
          lastHeartbeat: now,
          endedAt: null,
          status: "active",
          spec: null,
          command: null,
          agent: null,
          tmuxSession: null,
          ccSessionId: null,
          tmuxTarget: null,
          rateLimitUtilization: null,
          rateLimitType: null,
          totalCostUsd: null,
          model: null,
          sessionType: "ad_hoc",
        };
        sessions.set(event.session_id, session);
        logger.info("session-manager: session started", {
          id: event.session_id,
        });
        break;
      }
      case "session_update": {
        const existing = sessions.get(event.session_id);
        if (existing) {
          existing.lastHeartbeat = event.timestamp;
          // If session was idle, reactivate it on heartbeat
          if (existing.status === "idle") {
            existing.status = "active";
          }
          logger.debug("session-manager: session updated", {
            id: event.session_id,
          });
        } else {
          logger.warn(
            "session-manager: update for unknown session",
            { id: event.session_id },
          );
        }
        break;
      }
      case "session_end": {
        const existing = sessions.get(event.session_id);
        if (existing) {
          existing.status = "ended";
          existing.endedAt = new Date().toISOString();
          logger.info("session-manager: session ended", {
            id: event.session_id,
          });
        } else {
          logger.warn(
            "session-manager: end for unknown session",
            { id: event.session_id },
          );
        }
        break;
      }
    }
  }

  function getAll(): Session[] {
    return Array.from(sessions.values());
  }

  function getActive(): Session[] {
    return Array.from(sessions.values()).filter(
      (s) => s.status === "active" || s.status === "idle",
    );
  }

  function getById(id: string): Session | null {
    return sessions.get(id) ?? null;
  }

  function sweepIdle(): void {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.status !== "active") continue;
      const lastActivity = new Date(session.lastHeartbeat).getTime();
      if (now - lastActivity > IDLE_THRESHOLD_MS) {
        session.status = "idle";
        logger.info("session-manager: session marked idle", {
          id: session.id,
        });
      }
    }
  }

  function stop(): void {
    clearInterval(sweepTimer);
  }

  return {
    handleWatcherEvent,
    getAll,
    getActive,
    getById,
    sweepIdle,
    stop,
  };
}
