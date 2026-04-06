import { hostname } from "node:os";
import { existsSync } from "node:fs";
import { logger } from "@nexus/core";
import type { Session, WatcherEvent } from "@nexus/core";

const IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes (same as idle → stale)
const SWEEP_INTERVAL_MS = 60 * 1000; // 60 seconds
const DEFAULT_ENDED_SESSION_TTL_MS = 3_600_000; // 1 hour

/** Options for configuring a session manager instance. */
export interface SessionManagerOptions {
  /**
   * How long (in ms) to retain ended sessions in memory before evicting them
   * during a sweep. Defaults to 1 hour (3_600_000 ms).
   */
  endedSessionTtlMs?: number;

  /**
   * How long (in ms) an idle session must remain idle before being promoted to
   * `stale`. Defaults to 5 minutes (300_000 ms).
   */
  staleThresholdMs?: number;
}

export interface SessionManager {
  handleWatcherEvent(event: WatcherEvent): void;
  getAll(): Session[];
  getActive(): Session[];
  getById(id: string): Session | null;
  sweepIdle(): void;
  /** Stop the periodic sweep timer. */
  stop(): void;
}

export function createSessionManager(
  options: SessionManagerOptions = {},
): SessionManager {
  const {
    endedSessionTtlMs = DEFAULT_ENDED_SESSION_TTL_MS,
    staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
  } = options;
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
        logger.info({ id: event.session_id }, "session-manager: session started");
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
          logger.debug({ id: event.session_id }, "session-manager: session updated");
        } else {
          logger.warn(
            { id: event.session_id },
            "session-manager: update for unknown session",
          );
        }
        break;
      }
      case "session_end": {
        const existing = sessions.get(event.session_id);
        if (existing) {
          existing.status = "ended";
          existing.endedAt = new Date().toISOString();
          logger.info({ id: event.session_id }, "session-manager: session ended");
        } else {
          logger.warn(
            { id: event.session_id },
            "session-manager: end for unknown session",
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

    // Snapshot the set of sessions that are already idle before this sweep so
    // that sessions freshly transitioned to idle in pass 1 are not immediately
    // promoted to stale in pass 2.
    const alreadyIdle = new Set<string>(
      Array.from(sessions.values())
        .filter((s) => s.status === "idle")
        .map((s) => s.id),
    );

    // Pass 1: Mark active sessions as idle if they have exceeded the idle threshold.
    for (const session of sessions.values()) {
      if (session.status !== "active") continue;
      const lastActivity = new Date(session.lastHeartbeat).getTime();
      if (now - lastActivity > IDLE_THRESHOLD_MS) {
        session.status = "idle";
        logger.info({ id: session.id }, "session-manager: session marked idle");
      }
    }

    // Pass 2: Promote pre-existing idle sessions to stale or errored.
    // Sessions just transitioned from active to idle in pass 1 are excluded.
    for (const session of sessions.values()) {
      if (session.status !== "idle") continue;
      if (!alreadyIdle.has(session.id)) continue;

      const lastActivity = new Date(session.lastHeartbeat).getTime();

      // On Linux, check /proc/{pid} — if the process is gone, mark errored.
      if (process.platform === "linux" && session.pid && session.pid > 0) {
        const procPath = `/proc/${session.pid}`;
        if (!existsSync(procPath)) {
          session.status = "errored";
          logger.warn(
            { id: session.id, pid: session.pid },
            "session-manager: session marked errored (process not found in /proc)",
          );
          continue;
        }
      }

      if (now - lastActivity > staleThresholdMs) {
        session.status = "stale";
        logger.info({ id: session.id }, "session-manager: session marked stale");
      }
    }

    // Pass 3: Evict ended sessions that have exceeded the TTL.
    for (const [id, session] of sessions) {
      if (session.status !== "ended") continue;
      if (session.endedAt == null) continue;
      const endedAt = new Date(session.endedAt).getTime();
      if (now - endedAt > endedSessionTtlMs) {
        sessions.delete(id);
        logger.info({ id }, "session-manager: ended session evicted after TTL");
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
