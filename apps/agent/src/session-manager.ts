import { hostname } from "node:os";
import { existsSync } from "node:fs";
import { logger } from "@nexus/core/node";
import type { Session, WatcherEvent } from "@nexus/core";
import type { Db } from "@nexus/db";
import { loadActiveSessions, upsertSession } from "./db/sessions";

const IDLE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes (bumped from 5m by bump-session-idle-threshold)
const DEFAULT_STALE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes (same as idle → stale)
const SWEEP_INTERVAL_MS = 60 * 1000; // 60 seconds
const DEFAULT_ENDED_SESSION_TTL_MS = 3_600_000; // 1 hour (eviction of ended rows; independent of idle/stale window)

/** Options for configuring a session manager instance. */
export interface SessionManagerOptions {
  /**
   * How long (in ms) to retain ended sessions in memory before evicting them
   * during a sweep. Defaults to 1 hour (3_600_000 ms).
   */
  endedSessionTtlMs?: number;

  /**
   * How long (in ms) an idle session must remain idle before being promoted to
   * `stale`. Defaults to 60 minutes (3_600_000 ms) per `bump-session-idle-threshold`.
   */
  staleThresholdMs?: number;

  /**
   * Optional database connection for write-through / read-through caching.
   * When provided, sessions are persisted to Postgres and recovered on startup.
   * When omitted, the manager operates in memory-only mode (backward compatible).
   */
  db?: Db;
}

export interface SessionManager {
  handleWatcherEvent(event: WatcherEvent): void;
  getAll(): Session[];
  getActive(): Session[];
  getById(id: string): Session | null;
  sweepIdle(): void;
  /** Stop the periodic sweep timer. */
  stop(): void;
  /**
   * Initialize from DB — loads active sessions and validates PIDs.
   * Only meaningful when constructed with a `db` option.
   * Returns a promise so callers can await startup recovery.
   */
  init(): Promise<void>;
  /**
   * Update sub-agent tree linkage for a child session (parent_session_id +
   * child_role). Wired via `process-hook-event.ts` from the `agent_spawn`
   * dispatch path.
   *
   * Spec: openspec/changes/add-subagent-tree-columns (1.3).
   *
   * Idempotent: a session with linkage already set is overwritten with the
   * new values. Returns silently if the session id is not present in the
   * cache (matches existing `session_update`/`session_end` "unknown session"
   * behaviour — the wire-in is best-effort).
   */
  updateLinkage(
    sessionId: string,
    linkage: { parentSessionId?: string | null; childRole?: string | null },
  ): void;
  /**
   * Patch arbitrary mutable fields on the in-memory session row and trigger
   * write-through. Used by helpers (e.g. `processHookEvent`) that need to
   * persist enriched fields (git_provider/git_owner_repo) without breaking
   * encapsulation of the Map. No-op when the session id is unknown.
   */
  patch(sessionId: string, patch: Partial<Session>): void;
}

export function createSessionManager(
  options: SessionManagerOptions = {},
): SessionManager {
  const {
    endedSessionTtlMs = DEFAULT_ENDED_SESSION_TTL_MS,
    staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
    db = null,
  } = options;
  const sessions = new Map<string, Session>();
  const machine = hostname();

  const sweepTimer = setInterval(() => {
    sweepIdle();
  }, SWEEP_INTERVAL_MS);

  /**
   * Initialize the session manager from the database.
   * Loads active sessions, validates PIDs, and marks dead ones as ended.
   */
  async function init(): Promise<void> {
    if (!db) return;

    try {
      const loaded = await loadActiveSessions(db);
      logger.info({ count: loaded.length }, "session-manager: loaded active sessions from DB");

      for (const session of loaded) {
        // Validate PID — if the process is gone, mark as ended
        if (session.pid && session.pid > 0 && !isPidAlive(session.pid)) {
          session.status = "ended";
          session.endedAt = new Date();
          logger.warn(
            { id: session.id, pid: session.pid },
            "session-manager: marking session ended (PID not found on startup)",
          );
          // Write the ended status back to DB
          await writeThroughSafe(session);
        }
        sessions.set(session.id, session);
      }
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "session-manager: failed to load sessions from DB — starting with empty cache",
      );
    }
  }

  function handleWatcherEvent(event: WatcherEvent): void {
    switch (event.type) {
      case "session_start": {
        const now = new Date();
        const session: Session = {
          id: event.session_id,
          pid: 0,
          project: event.project || null,
          projectId: null,
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
          credentialId: null,
          credentialFingerprint: null,
          sessionType: "ad_hoc",
          parentSessionId: null,
          childRole: null,
        };
        // Write-through: DB first, then Map
        writeThroughSafe(session);
        sessions.set(event.session_id, session);
        logger.info({ id: event.session_id }, "session-manager: session started");
        break;
      }
      case "session_update": {
        const existing = sessions.get(event.session_id);
        if (existing) {
          existing.lastHeartbeat = new Date(event.timestamp);
          // If session was idle, reactivate it on heartbeat
          if (existing.status === "idle") {
            existing.status = "active";
          }
          // Write-through: DB first, then Map (Map already updated above)
          writeThroughSafe(existing);
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
          existing.endedAt = new Date();
          // Write-through: DB first, then Map (Map already updated above)
          writeThroughSafe(existing);
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

  /**
   * Get a session by ID — checks Map first, falls back to DB on miss.
   * Cache-miss results from DB are added to the Map.
   */
  function getById(id: string): Session | null {
    const cached = sessions.get(id);
    if (cached) return cached;

    // Read-through: try DB on cache miss (fire-and-forget async for sync interface)
    if (db) {
      readThroughAsync(id);
    }
    return null;
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
      const lastActivity = session.lastHeartbeat.getTime();
      if (now - lastActivity > IDLE_THRESHOLD_MS) {
        session.status = "idle";
        writeThroughSafe(session);
        logger.info({ id: session.id }, "session-manager: session marked idle");
      }
    }

    // Pass 2: Promote pre-existing idle sessions to stale or errored.
    // Sessions just transitioned from active to idle in pass 1 are excluded.
    for (const session of sessions.values()) {
      if (session.status !== "idle") continue;
      if (!alreadyIdle.has(session.id)) continue;

      const lastActivity = session.lastHeartbeat.getTime();

      // On Linux, check /proc/{pid} — if the process is gone, mark errored.
      if (process.platform === "linux" && session.pid && session.pid > 0) {
        const procPath = `/proc/${session.pid}`;
        if (!existsSync(procPath)) {
          session.status = "errored";
          writeThroughSafe(session);
          logger.warn(
            { id: session.id, pid: session.pid },
            "session-manager: session marked errored (process not found in /proc)",
          );
          continue;
        }
      }

      if (now - lastActivity > staleThresholdMs) {
        session.status = "stale";
        writeThroughSafe(session);
        logger.info({ id: session.id }, "session-manager: session marked stale");
      }
    }

    // Pass 3: Evict ended sessions that have exceeded the TTL.
    for (const [id, session] of sessions) {
      if (session.status !== "ended") continue;
      if (session.endedAt == null) continue;
      const endedAt = session.endedAt.getTime();
      if (now - endedAt > endedSessionTtlMs) {
        sessions.delete(id);
        logger.info({ id }, "session-manager: ended session evicted after TTL");
      }
    }
  }

  function stop(): void {
    clearInterval(sweepTimer);
  }

  function updateLinkage(
    sessionId: string,
    linkage: { parentSessionId?: string | null; childRole?: string | null },
  ): void {
    const existing = sessions.get(sessionId);
    if (!existing) {
      logger.warn(
        { id: sessionId },
        "session-manager: updateLinkage for unknown session (best-effort skip)",
      );
      return;
    }
    if (linkage.parentSessionId !== undefined) {
      existing.parentSessionId = linkage.parentSessionId;
    }
    if (linkage.childRole !== undefined) {
      existing.childRole = linkage.childRole;
    }
    writeThroughSafe(existing);
    logger.info(
      {
        id: sessionId,
        parentSessionId: existing.parentSessionId,
        childRole: existing.childRole,
      },
      "session-manager: sub-agent linkage updated",
    );
  }

  function patch(sessionId: string, patchObj: Partial<Session>): void {
    const existing = sessions.get(sessionId);
    if (!existing) {
      logger.warn(
        { id: sessionId },
        "session-manager: patch for unknown session (best-effort skip)",
      );
      return;
    }
    Object.assign(existing, patchObj);
    writeThroughSafe(existing);
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /** Check if a PID is alive. */
  function isPidAlive(pid: number): boolean {
    // On Linux, check /proc/{pid}
    if (process.platform === "linux") {
      return existsSync(`/proc/${pid}`);
    }
    // Fallback: try kill(pid, 0) — throws if process doesn't exist
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write a session to DB without throwing — logs errors but does not
   * propagate them. This is graceful degradation: the in-memory Map
   * is always updated even if DB writes fail.
   */
  function writeThroughSafe(session: Session): void {
    if (!db) return;
    upsertSession(db, session).catch((err) => {
      logger.error(
        { id: session.id, error: err instanceof Error ? err.message : String(err) },
        "session-manager: DB write-through failed — Map updated, DB out of sync",
      );
    });
  }

  /**
   * Async read-through: query DB for a session and add to Map if found.
   * This runs in the background — the current getById call returns null,
   * but subsequent calls will hit the Map.
   */
  function readThroughAsync(id: string): void {
    if (!db) return;
    const activeDb = db;
    // Each `.then()` has its own `.catch()` per spec finalize-audit-cleanup
    // requirement "No unhandled Promise rejections". The catches log and
    // return `undefined` so the chain short-circuits gracefully without
    // throwing an unhandled rejection.
    import("./db/sessions")
      .then(({ getSessionById }) => getSessionById(activeDb, id))
      .catch((err) => {
        logger.error(
          { id, err, context: "session-manager: read-through DB query failed" },
          "session-manager: read-through DB query failed",
        );
        return undefined;
      })
      .then((row) => {
        if (row && !sessions.has(id)) {
          // Convert row to Session — import the mapper
          const session: Session = {
            id: row.id,
            pid: row.pid ?? 0,
            project: undefined,
            projectId: row.projectId ?? null,
            machine: row.machine ?? null,
            cwd: row.cwd ?? "",
            branch: row.branch ?? null,
            startedAt: row.startedAt,
            lastHeartbeat: row.lastActivity,
            endedAt: row.endedAt ?? null,
            status: (row.status as Session["status"]) ?? "active",
            spec: row.spec ?? null,
            command: null,
            agent: null,
            tmuxSession: row.tmuxSession ?? null,
            ccSessionId: row.ccSessionId ?? null,
            tmuxTarget: row.tmuxTarget ?? null,
            rateLimitUtilization: row.rateLimitUtilization ?? null,
            rateLimitType: null,
            totalCostUsd: row.totalCostUsd ?? null,
            model: row.model ?? null,
            credentialId: row.credentialId ?? null,
            credentialFingerprint: row.credentialFingerprint ?? null,
            sessionType: (row.sessionType as Session["sessionType"]) ?? "ad_hoc",
            parentSessionId: row.parentSessionId ?? null,
            childRole: row.childRole ?? null,
          };
          sessions.set(id, session);
          logger.debug({ id }, "session-manager: read-through populated cache from DB");
        }
      })
      .catch((err) => {
        logger.error(
          { id, err, context: "session-manager: read-through cache population failed" },
          "session-manager: read-through cache population failed",
        );
      });
  }

  return {
    handleWatcherEvent,
    getAll,
    getActive,
    getById,
    sweepIdle,
    stop,
    init,
    updateLinkage,
    patch,
  };
}
