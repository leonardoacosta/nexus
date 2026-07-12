/**
 * Built-in socket event dispatcher.
 *
 * Replaces the former socket-dispatch intermediary layer: consumes
 * SocketEvents and fans them out to the SessionManager, LifecycleBus,
 * notification history, and TTS channel.
 */

import { createLogger } from "@nexus/core/node";
import type { WatcherEvent } from "@nexus/core";
import type { Db } from "@nexus/db";
import { credentials, eq } from "@nexus/db";
import { recordSessionStop } from "../../db/sessions";
import type { SocketEvent, SessionStopEvent } from "../../types/socket-events";
import type { SessionManager } from "../../session-manager";
import { recordNotification } from "../command-handler";
import { isUnspeakable } from "../../notifications/speakability";
import { processHookEvent } from "../process-hook-event";
import { evaluateAndDispatch } from "../../notifications/hook-trigger";
import type { NotificationManager } from "../../notifications/manager";
import type { HookEventPayload } from "../../routes/hooks-types";
import { getTracer } from "../../otel";
import type { SocketDispatchDeps, SocketEventHandler } from "./types";

const log = createLogger("agent:socket-server");

/**
 * Create the default socket event handler that dispatches events directly
 * to the lifecycle bus and session manager. This replaces the former
 * socket-dispatch intermediary layer.
 */
export function createSocketEventDispatcher(
  deps: SocketDispatchDeps,
): SocketEventHandler {
  const { sessionManager, lifecycleBus, db, getNotificationManager } = deps;

  return function dispatchEvent(event: SocketEvent): void {
    getTracer().startActiveSpan(
      "hook.dispatch",
      {
        attributes: {
          "hook.event": event.event,
          // `session_id` is present on every session-scoped event; absent on
          // project-level ones (telemetry, deploy_status). `?? ""` keeps the
          // attribute a defined string (the logger mixin reads the active span).
          "session.id": "session_id" in event ? (event.session_id ?? "") : "",
        },
      },
      (span) => {
        try {
          dispatchEventInner(event);
        } finally {
          span.end();
        }
      },
    );
  };

  function dispatchEventInner(event: SocketEvent): void {
    switch (event.event) {
      case "session_start": {
        const watcherEvent: WatcherEvent = {
          type: "session_start",
          session_id: event.session_id,
          project: event.project ?? "",
          path: event.cwd ?? "",
        };
        sessionManager.handleWatcherEvent(watcherEvent);

        // Best-effort credential binding: if the event includes a
        // credential fingerprint, look up the credential and populate
        // credentialId + credentialFingerprint on the session.
        if (event.credential_fingerprint && db) {
          bindSessionCredential(
            sessionManager,
            db,
            event.session_id,
            event.credential_fingerprint,
          ).catch((err: unknown) => {
            log.warn(
              { error: err, sessionId: event.session_id },
              "socket: credential binding failed (best-effort)",
            );
          });
        }

        // Shared spine: schema-drift + git origin resolver. Fire-and-forget
        // (the dispatcher is sync; the helper handles its own errors).
        // Wires add-schema-drift-detector 1.3 + add-git-project-resolver 1.3.
        processHookEvent(
          {
            eventType: "session_start",
            sessionId: event.session_id,
            payload: event as unknown as Record<string, unknown>,
            source: "socket",
            cwd: event.cwd ?? null,
          },
          { sessionManager, db: db ?? null },
        ).catch((err: unknown) => {
          log.warn(
            { err, sessionId: event.session_id },
            "socket: processHookEvent(session_start) rejected unexpectedly",
          );
        });

        lifecycleBus.emit("SessionStarted", {
          sessionId: event.session_id,
          project: event.project,
          cwd: event.cwd,
          model: event.model,
        });
        log.info(
          {
            sessionId: event.session_id,
            project: event.project,
            model: event.model,
            credentialFingerprint: event.credential_fingerprint ?? null,
          },
          "socket: session_start",
        );
        break;
      }

      case "session_stop": {
        const watcherEvent: WatcherEvent = {
          type: "session_end",
          session_id: event.session_id,
        };
        sessionManager.handleWatcherEvent(watcherEvent);
        // Agent-state spine (session-enrichment): Stop → `ready`. Persisted via
        // the shared hook processor (deriveAgentState maps session_stop → ready).
        deriveAndPersistAgentState(
          event.event,
          event.session_id,
          event as unknown as Record<string, unknown>,
          { sessionManager, db: db ?? null },
        );

        // Persist stop-reason fields (nx-f060f). Fire-and-forget keyed UPDATE —
        // mirrors the `updateSessionGitOrigin` idiom in process-hook-event.ts:184.
        if (db) {
          recordSessionStop(db, event.session_id, {
            stopReason: event.stop_reason,
            errorDetails: event.error_details,
          }).catch((err: unknown) => {
            log.warn(
              { err, sessionId: event.session_id },
              "socket: recordSessionStop rejected (best-effort)",
            );
          });
        }

        // Revive the dormant notification path (nx-f060f D1). A crash stop
        // (crash_flag or stop_reason ∈ CRASH_STOP_REASONS) fires a desktop
        // notification whose body carries the captured error text;
        // stop_reason "api_error" routes separately to apiErrorRule
        // (desktop+tts) — see dispatchStopNotification (nx-7tfim). Map the
        // SessionStopEvent wire fields onto the HookEventPayload shape the rule
        // reads, then hand off to the shared trigger orchestrator (suppression
        // + settings filter + manager.send live there). Fire-and-forget — the
        // orchestrator never throws, but we .catch the lazy-manager edge.
        dispatchStopNotification(event);

        lifecycleBus.emit("SessionStopped", {
          sessionId: event.session_id,
        });
        log.info({ sessionId: event.session_id }, "socket: session_stop");
        break;
      }

      case "session_heartbeat": {
        const watcherEvent: WatcherEvent = {
          type: "session_update",
          session_id: event.session_id,
          timestamp: new Date().toISOString(),
        };
        sessionManager.handleWatcherEvent(watcherEvent);
        // Agent-state spine (session-enrichment): a mid-turn tool hook
        // (PreToolUse/PostToolUse/UserPromptSubmit/SubagentStart) reaches the
        // agent as a heartbeat → `blocked`.
        deriveAndPersistAgentState(
          event.event,
          event.session_id,
          event as unknown as Record<string, unknown>,
          { sessionManager, db: db ?? null },
        );
        lifecycleBus.emit("SessionHeartbeat", {
          sessionId: event.session_id,
          timestamp: new Date().toISOString(),
        });
        log.debug({ sessionId: event.session_id }, "socket: session_heartbeat");
        break;
      }

      case "notification": {
        const requestedChannels = event.channels ?? ["tts"];
        const messageType = event.message_type ?? "brief";
        const project = event.project ?? null;

        // Strip TTS for unspeakable bodies (e.g. raw file paths). Other
        // channels (desktop, slack) still receive the notification — the
        // user wants to know it happened, just not have it read aloud.
        const unspeakable = isUnspeakable(event.message);
        const effectiveChannels = unspeakable
          ? requestedChannels.filter((c) => c !== "tts")
          : requestedChannels;
        if (unspeakable && requestedChannels.includes("tts")) {
          log.info(
            { message: event.message, project },
            "socket: TTS suppressed for unspeakable body",
          );
        }

        log.info(
          {
            message: event.message,
            messageType,
            channels: effectiveChannels,
            project,
            hasQuestion: !!event.question,
          },
          "socket: notification",
        );

        // Agent-state spine (session-enrichment): a session-scoped Notification
        // means the agent is awaiting user input (permission prompt / idle) →
        // `waiting`. Project-level notifications with no session_id carry no
        // per-session signal and are skipped by the sessionId guard below.
        if (event.session_id) {
          deriveAndPersistAgentState(
            event.event,
            event.session_id,
            event as unknown as Record<string, unknown>,
            { sessionManager, db: db ?? null },
          );
        }

        // Record in history for the `history` command.
        recordNotification(event.message, messageType, effectiveChannels);

        // Emit to lifecycle bus for local subscribers (SSE, notification
        // router). After `swift-owns-elevenlabs-synth`, NotificationFired is
        // signal-only — the Mac listener performs synthesis locally via
        // NexusShared.ElevenLabsClient + Keychain. No audio bytes flow over
        // the bus.
        lifecycleBus.emit("NotificationFired", {
          id: `socket-notif-${Date.now()}`,
          title: "Notification",
          body: event.message,
          channel: effectiveChannels.join(","),
          project: project ?? undefined,
          message: event.message, // back-compat alias
        });

        // TTS routing: after remove-notification-channels (P4), the agent
        // no longer owns synthesis. The lifecycleBus.emit above is the
        // signal the Mac listener consumes — there is no separate
        // `sendTtsNotification` call any more, the channel is a pure
        // signal (see notifications/router.ts → signalOnlyChannel).
        break;
      }

      case "answer": {
        log.info(
          {
            textLen: event.text.length,
            sessionId: event.session_id,
          },
          "socket: answer (not yet wired to tmux dispatch)",
        );
        break;
      }

      case "agent_spawn": {
        log.info(
          {
            sessionId: event.session_id,
            agentType: event.agent_type,
            model: event.model,
            parentSessionId: event.parent_session_id ?? event.parent_agent ?? null,
            childRole: event.child_role ?? null,
          },
          "socket: agent_spawn",
        );
        // Shared spine: schema-drift + sub-agent tree linkage. Closes
        // add-subagent-tree-columns 1.3 — populates parent_session_id +
        // child_role on the in-memory session and DB row.
        if (event.session_id) {
          processHookEvent(
            {
              eventType: "agent_spawn",
              sessionId: event.session_id,
              payload: event as unknown as Record<string, unknown>,
              source: "socket",
            },
            { sessionManager, db: db ?? null },
          ).catch((err: unknown) => {
            log.warn(
              { err, sessionId: event.session_id },
              "socket: processHookEvent(agent_spawn) rejected unexpectedly",
            );
          });
        }
        break;
      }

      case "agent_complete": {
        log.info(
          {
            sessionId: event.session_id,
            agentType: event.agent_type,
            durationMs: event.duration_ms,
          },
          "socket: agent_complete",
        );
        break;
      }

      case "telemetry": {
        log.debug(
          { keys: Object.keys(event.payload) },
          "socket: telemetry",
        );
        break;
      }

      case "session_summary": {
        log.info(
          {
            sessionId: event.session_id,
            project: event.project,
            toolCount: Object.keys(event.tool_counts ?? {}).length,
            failureCount: event.failure_count,
            durationMs: event.duration_ms,
          },
          "socket: session_summary",
        );
        break;
      }

      case "deploy_status": {
        const target = event.target ?? "local";
        const service = event.service ?? "unknown";
        log.info(
          {
            project: event.project,
            status: event.status,
            target,
            service,
          },
          "socket: deploy_status",
        );
        break;
      }

      default: {
        log.warn({ event }, "socket: unknown event type");
      }
    }
  }

  /**
   * Fire the session_stop crash notification (nx-f060f D1). Resolves the
   * shared NotificationManager singleton lazily (it is created asynchronously
   * by `initNotificationRoutes`, so it may be null until then) and hands the
   * mapped payload to the trigger orchestrator. No-ops when the DB or manager
   * accessor is absent (unit-test wiring) or the manager is not yet ready.
   *
   * The non-crash case is filtered inside `sessionStopRule` itself
   * (`isCrashStop` returns null), so a normal stop produces no notification.
   *
   * `stop_reason === "api_error"` is routed to the synthetic `api_error`
   * eventType key instead of `session_stop` (nx-7tfim), so `apiErrorRule`
   * (desktop+tts, severity error) fires instead of `sessionStopRule` — which
   * explicitly excludes `api_error` from CRASH_STOP_REASONS and would
   * otherwise silently produce no notification for this stop reason.
   */
  function dispatchStopNotification(event: SessionStopEvent): void {
    if (!db || !getNotificationManager) return;
    const manager = getNotificationManager();
    if (!manager) return;

    // Map the SessionStopEvent wire shape onto the HookEventPayload the rule
    // reads. `stop_reason` drives the crash predicate (CRASH_STOP_REASONS);
    // `error_details` flows into the per-reason body.
    const payload: HookEventPayload = {
      event: "session_stop",
      session_id: event.session_id,
      stop_reason: event.stop_reason,
      error_details: event.error_details,
    };

    // api_error crash stops route to the `api_error` rule key (desktop+tts,
    // severity error) — every other stop_reason keeps going through
    // `session_stop` (`sessionStopRule`, desktop only). See CRASH_STOP_REASONS
    // in `notifications/hook-rules.ts` for why api_error can't just stay in
    // that set.
    const eventType =
      event.stop_reason === "api_error" ? "api_error" : "session_stop";

    evaluateAndDispatch(db, manager, eventType, payload).catch(
      (err: unknown) => {
        log.warn(
          { err, sessionId: event.session_id, eventType },
          "socket: session_stop notification dispatch rejected (best-effort)",
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget agent-state derivation + persistence for a session-scoped
 * lifecycle event (session-enrichment). Routes through the shared
 * `processHookEvent` spine, which maps the event name to a blocked/waiting/
 * ready state (`deriveAgentState`) and persists it via `updateSessionAgentState`.
 *
 * The dispatcher is synchronous; this returns immediately and swallows any
 * rejection so an agent-state hiccup never breaks the primary dispatch path.
 */
function deriveAndPersistAgentState(
  eventType: string,
  sessionId: string,
  payload: Record<string, unknown>,
  deps: { sessionManager: SessionManager; db: Db | null },
): void {
  processHookEvent(
    { eventType, sessionId, payload, source: "socket" },
    deps,
  ).catch((err: unknown) => {
    log.warn(
      { err, eventType, sessionId },
      "socket: processHookEvent(agent_state) rejected unexpectedly",
    );
  });
}

/**
 * Best-effort credential binding for a session.
 *
 * Looks up the credential by fingerprint and mutates the in-memory session
 * with `credentialId` and `credentialFingerprint`. The session manager's
 * write-through will persist the update on the next upsert cycle, but we
 * also trigger an explicit upsert to ensure the DB row is updated promptly.
 *
 * Never throws — callers should `.catch()` to avoid unhandled rejections.
 */
async function bindSessionCredential(
  sessionManager: SessionManager,
  db: Db,
  sessionId: string,
  fingerprint: string,
): Promise<void> {
  const session = sessionManager.getById(sessionId);
  if (!session) {
    log.debug({ sessionId }, "socket: credential binding skipped — session not found in cache");
    return;
  }

  // Always store the fingerprint, even if we can't resolve the credential ID.
  session.credentialFingerprint = fingerprint;

  // Look up the credential by fingerprint.
  const rows = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(eq(credentials.fingerprint, fingerprint))
    .limit(1);

  if (rows.length > 0 && rows[0]) {
    session.credentialId = rows[0].id;
    log.info(
      { sessionId, credentialId: rows[0].id, fingerprint },
      "socket: session bound to credential",
    );
  } else {
    log.debug(
      { sessionId, fingerprint },
      "socket: no credential found for fingerprint — credentialId stays null",
    );
  }

  // Trigger an explicit write-through to persist the binding.
  // Import upsertSession to avoid coupling to session-manager internals.
  const { upsertSession } = await import("../../db/sessions");
  await upsertSession(db, session);
}
