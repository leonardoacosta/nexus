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
import { credentials, eq, sessions, and, or, isNull, inArray, desc } from "@nexus/db";
import {
  recordSessionStop,
  updateSessionModel,
  updateSessionCcSessionId,
} from "../../db/sessions";
import type {
  SocketEvent,
  SessionStartEvent,
  SessionStopEvent,
} from "../../types/socket-events";
import type { SessionManager } from "../../session-manager";
import { recordNotification } from "../command-handler";
import { isUnspeakable } from "../../notifications/speakability";
import { processHookEvent } from "../process-hook-event";
import { evaluateAndDispatch } from "../../notifications/hook-trigger";
import type { NotificationManager } from "../../notifications/manager";
import type { HookEventPayload } from "../../routes/hooks-types";
import { getTracer } from "../../otel";
import { fetchPaneTranslationMap } from "./pane-translation";
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
          cc_session_id: event.cc_session_id,
        };
        // Pane-based session correlation (reconcile-session-id-universes,
        // tasks 2.1/2.2): before letting `handleWatcherEvent` create a second
        // (UUID-keyed) row, try to link this hook-sourced event to an
        // existing process-watcher row via the hook's `tmux_target`. Pane
        // translation + the DB lookup are both async, so this is fired via a
        // small helper rather than awaited inline — matching this file's
        // existing fire-and-forget shape for other async work (see
        // `bindSessionCredential` a few lines below, which is also started
        // with `.catch()` and never awaited at this level). Internally the
        // helper is sequential: it awaits both the pane translation and the
        // DB lookup before deciding which branch to take, so the "call
        // handleWatcherEvent" and "skip it, correlate instead" branches can
        // never race each other. See design.md § Fix.
        correlateSessionStart(event, watcherEvent, sessionManager, db).catch(
          (err: unknown) => {
            log.warn(
              { err, sessionId: event.session_id },
              "socket: session_start correlation failed unexpectedly",
            );
          },
        );

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

        // Bridge-column backfill (fix-cc-session-id-bridge, nx-22xz8): the
        // value is threaded through `watcherEvent.cc_session_id` above so it
        // lands in the SAME insert that creates the row (session-manager.ts's
        // `session_start` case) — no separate follow-up UPDATE. A previous
        // version of this fix issued a follow-up `updateSessionCcSessionId`
        // UPDATE here, but that raced the (unawaited) row-creating INSERT
        // inside `writeThroughSafe` and silently no-op'd when the UPDATE ran
        // before the row existed.

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
        // add-session-model-authority: persist the raw model when the heartbeat
        // carries one (last-write-wins captures mid-session `/model` switches).
        // Fire-and-forget keyed UPDATE, mirroring deriveAndPersistAgentState —
        // updateSessionModel no-ops on a blank/absent value.
        if (db && event.model) {
          updateSessionModel(db, event.session_id, event.model).catch(
            (err: unknown) => {
              log.warn(
                { err, sessionId: event.session_id },
                "socket: updateSessionModel(heartbeat) rejected (best-effort)",
              );
            },
          );
        }
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

      // Notification-trigger events (add-hooks-notification-triggers, nx-z0vm4).
      // These reach `hookRules` + suppression ONLY via `evaluateAndDispatch`.
      // Before nx-z0vm4 the switch had no cases for them, so even after they
      // passed `isSocketEvent` they fell through to `default` and produced zero
      // notifications — the feature was dead in production from 2026-04-27.
      // Map the wire fields onto the `HookEventPayload` the rules read (rules
      // consume both the cc-side key and its alias via `??`) and hand off to the
      // shared trigger orchestrator, which owns suppression + settings filter +
      // `manager.send`. Fire-and-forget — see `fireHookNotification`.
      case "tool_use_fail": {
        log.info(
          {
            sessionId: event.session_id,
            tool: event.tool_name ?? event.tool,
            project: event.project,
          },
          "socket: tool_use_fail",
        );
        fireHookNotification("tool_use_fail", {
          event: "tool_use_fail",
          session_id: event.session_id,
          project: event.project,
          tool: event.tool,
          tool_name: event.tool_name,
          error: event.error,
          error_message: event.error_message,
          command: event.command,
        });
        break;
      }

      case "permission_request": {
        log.info(
          {
            sessionId: event.session_id,
            tool: event.tool_name ?? event.tool,
            project: event.project,
          },
          "socket: permission_request",
        );
        fireHookNotification("permission_request", {
          event: "permission_request",
          session_id: event.session_id,
          cc_session_id: event.cc_session_id,
          project: event.project,
          tool: event.tool,
          tool_name: event.tool_name,
          session_name: event.session_name,
        });
        break;
      }

      case "hook_failure": {
        log.info(
          {
            sessionId: event.session_id,
            hook: event.hook_name ?? event.handler,
            project: event.project,
          },
          "socket: hook_failure",
        );
        fireHookNotification("hook_failure", {
          event: "hook_failure",
          session_id: event.session_id,
          project: event.project,
          handler: event.handler,
          hook_name: event.hook_name,
          error: event.error,
          error_message: event.error_message,
          exit_code: event.exit_code,
          stderr: event.stderr,
        });
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

    fireHookNotification(eventType, payload);
  }

  /**
   * Shared notification hand-off (nx-z0vm4). Resolves the lazily-created
   * NotificationManager singleton and forwards to the trigger orchestrator
   * (`evaluateAndDispatch` — suppression + settings filter + `manager.send`
   * live there). No-ops when the DB or manager accessor is absent (unit-test
   * wiring) or the manager is not yet ready. Fire-and-forget: the orchestrator
   * never throws, but we `.catch` the lazy-manager edge. Used by
   * `dispatchStopNotification` (session_stop / api_error) and the
   * tool_use_fail / permission_request / hook_failure switch cases.
   */
  function fireHookNotification(
    eventType: string,
    payload: HookEventPayload,
  ): void {
    if (!db || !getNotificationManager) return;
    const manager = getNotificationManager();
    if (!manager) return;

    evaluateAndDispatch(db, manager, eventType, payload).catch(
      (err: unknown) => {
        log.warn(
          { err, sessionId: payload.session_id, eventType },
          "socket: notification dispatch rejected (best-effort)",
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pane-based session correlation for `session_start` (reconcile-session-id-
 * universes, tasks 2.1/2.2). Attempts to link this hook-sourced event to an
 * existing, not-yet-linked process-watcher row (Universe 1) via the hook's
 * `tmux_target` (raw `%N` pane-id), so the two "session universes" merge into
 * one row instead of `handleWatcherEvent` creating a second, UUID-keyed row.
 *
 * **Match found**: writes `event.session_id` onto the matched row's
 * `cc_session_id` column via `updateSessionCcSessionId` and returns WITHOUT
 * calling `handleWatcherEvent` — no second row is created for this session.
 *
 * **No match** (no `tmux_target` on the event, no `db` configured, the pane-
 * translation lookup misses, no matching DB row, or any lookup step throws):
 * falls back to TODAY'S UNCHANGED BEHAVIOR — calls `handleWatcherEvent`
 * exactly as before. This is a strict regression guard (design.md § Fix,
 * Non-Goals): the new path can only ADD correlation, never leave an unmatched
 * session worse off than it is today, which is why lookup failures are
 * caught here and folded into the same fallback rather than left to reject
 * the returned promise (that would skip the `handleWatcherEvent` call the
 * caller's `.catch()` doesn't restore).
 *
 * The two decisions (call `handleWatcherEvent` vs. correlate instead) can
 * never race: both awaits below resolve before either branch runs.
 */
async function correlateSessionStart(
  event: SessionStartEvent,
  watcherEvent: WatcherEvent,
  sessionManager: SessionManager,
  db: Db | undefined,
): Promise<void> {
  if (event.tmux_target && db) {
    try {
      const paneMap = await fetchPaneTranslationMap();
      const translated = paneMap.get(event.tmux_target);
      if (translated) {
        const matched = await findUnlinkedSessionByTmuxTarget(db, translated);
        if (matched) {
          await updateSessionCcSessionId(db, matched.id, event.session_id);
          log.debug(
            {
              sessionId: event.session_id,
              matchedSessionId: matched.id,
              tmuxTarget: translated,
            },
            "socket: session_start correlated to existing process-watcher row",
          );
          return;
        }
      }
    } catch (err: unknown) {
      log.warn(
        { err, sessionId: event.session_id, tmuxTarget: event.tmux_target },
        "socket: session_start correlation lookup failed — falling back to handleWatcherEvent",
      );
      // Fall through to the unchanged fallback below (regression guard).
    }
  }

  log.debug(
    { sessionId: event.session_id, tmuxTarget: event.tmux_target ?? null },
    "socket: session_start — no pane correlation match, calling handleWatcherEvent",
  );
  sessionManager.handleWatcherEvent(watcherEvent);
}

/**
 * Find the most-recently-active `active`/`idle` session row matching a
 * translated tmux `session:window.pane` address, excluding rows that already
 * carry a `cc_session_id` (idempotency — a repeat session_start/heartbeat-
 * shaped event for an already-correlated session must not re-match or
 * double-write). Picks the most recent `last_activity` when multiple rows
 * match a reused pane. Task 2.1 (reconcile-session-id-universes).
 */
async function findUnlinkedSessionByTmuxTarget(
  db: Db,
  tmuxTarget: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.tmuxTarget, tmuxTarget),
        inArray(sessions.status, ["active", "idle"]),
        or(isNull(sessions.ccSessionId), eq(sessions.ccSessionId, "")),
      ),
    )
    .orderBy(desc(sessions.lastActivity))
    .limit(1);
  return rows[0] ?? null;
}

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
