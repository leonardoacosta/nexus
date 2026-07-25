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
import { credentials, eq, sessions, and, or, isNull, inArray, desc, asc } from "@nexus/db";
import {
  recordSessionStop,
  updateSessionModel,
  updateSessionCcSessionId,
} from "../../db/sessions";
import type {
  SocketEvent,
  SessionStartEvent,
  SessionStopEvent,
  NotificationEvent,
} from "../../types/socket-events";
import type { SessionManager } from "../../session-manager";
import { recordNotification } from "../command-handler";
import { isUnspeakable } from "../../notifications/speakability";
import { processHookEvent } from "../process-hook-event";
import { evaluateAndDispatch } from "../../notifications/hook-trigger";
import type { NotificationManager } from "../../notifications/manager";
import type { CredentialPool } from "../../credentials/pool";
import { performCredentialSwap, isDebounced, armDebounce } from "../credential-swap-flow";
import { recordFailure } from "../credential-pool/rate-limit-tracker";
import { getActiveCredentialSnapshot } from "../../credentials/credential-watcher";
import { sendTextToSession } from "../../routes/commands-send-text";
import type { HookEventPayload } from "../../routes/hooks-types";
import { getTracer } from "../../otel";
import { fetchPaneTranslationMap } from "./pane-translation";
import type { SocketDispatchDeps, SocketEventHandler } from "./types";
import { isPidAlive } from "../../utils/pid";

const log = createLogger("agent:socket-server");

/**
 * Create the default socket event handler that dispatches events directly
 * to the lifecycle bus and session manager. This replaces the former
 * socket-dispatch intermediary layer.
 */
export function createSocketEventDispatcher(
  deps: SocketDispatchDeps,
): SocketEventHandler {
  const { sessionManager, lifecycleBus, db, getNotificationManager, getCredentialPool } = deps;

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
        // tasks 2.1/2.2/2.3): before letting `handleWatcherEvent` create a
        // second (UUID-keyed) row, try to link this hook-sourced event to an
        // existing process-watcher row via the hook's `tmux_target`. Pane
        // translation + the DB lookup are both async, so this is fired via a
        // small helper rather than awaited inline. Internally the helper is
        // sequential: it awaits both the pane translation and the DB lookup
        // before deciding which branch to take, so the "call
        // handleWatcherEvent" and "skip it, correlate instead" branches can
        // never race each other. See design.md § Fix.
        //
        // Task 2.3 correction: `resolveSessionStartTarget` RESOLVES the row
        // id that everything downstream must write against — the matched
        // process-watcher row's id when correlation succeeds, or
        // `event.session_id` on the unchanged fallback. `bindSessionCredential`
        // and `processHookEvent` are chained off that resolution (`.then`)
        // instead of being fired independently off the raw event: when
        // correlation succeeds, NO row with `id = event.session_id` exists,
        // so firing those two unconditionally against `event.session_id` (the
        // prior shape) silently no-op'd — 0 rows matched, no error — and
        // defeated model/cwd/git-origin/credential enrichment for exactly the
        // sessions this fix is meant to help.
        resolveSessionStartTarget(event, watcherEvent, sessionManager, db)
          .then((targetId) => {
            // Best-effort credential binding: if the event includes a
            // credential fingerprint, look up the credential and populate
            // credentialId + credentialFingerprint on the session.
            if (event.credential_fingerprint && db) {
              bindSessionCredential(
                sessionManager,
                db,
                targetId,
                event.credential_fingerprint,
              ).catch((err: unknown) => {
                log.warn(
                  { error: err, sessionId: event.session_id, targetId },
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
                sessionId: targetId,
                payload: event as unknown as Record<string, unknown>,
                source: "socket",
                cwd: event.cwd ?? null,
              },
              { sessionManager, db: db ?? null },
            ).catch((err: unknown) => {
              log.warn(
                { err, sessionId: event.session_id, targetId },
                "socket: processHookEvent(session_start) rejected unexpectedly",
              );
            });
          })
          .catch((err: unknown) => {
            log.warn(
              { err, sessionId: event.session_id },
              "socket: session_start correlation failed unexpectedly",
            );
          });

        // Bridge-column backfill (fix-cc-session-id-bridge, nx-22xz8): the
        // value is threaded through `watcherEvent.cc_session_id` above so it
        // lands in the SAME insert that creates the row (session-manager.ts's
        // `session_start` case) — no separate follow-up UPDATE. A previous
        // version of this fix issued a follow-up `updateSessionCcSessionId`
        // UPDATE here, but that raced the (unawaited) row-creating INSERT
        // inside `writeThroughSafe` and silently no-op'd when the UPDATE ran
        // before the row existed.

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

        // Deliver the notification exactly as before (history + lifecycle
        // bus). After `swift-owns-elevenlabs-synth`, NotificationFired is
        // signal-only — the Mac listener performs synthesis locally via
        // NexusShared.ElevenLabsClient + Keychain. No audio bytes flow over
        // the bus. TTS routing: after remove-notification-channels (P4), the
        // agent no longer owns synthesis — the emit below is the signal the
        // Mac listener consumes (see notifications/router.ts →
        // signalOnlyChannel).
        const deliver = (): void => {
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
          recordNotification(event.message, messageType, effectiveChannels);
          lifecycleBus.emit("NotificationFired", {
            id: `socket-notif-${Date.now()}`,
            title: "Notification",
            body: event.message,
            channel: effectiveChannels.join(","),
            project: project ?? undefined,
            message: event.message, // back-compat alias
          });
        };

        // Reactive rate-limit swap (wire-reactive-rate-limit-swap, tasks
        // 2.2/2.3): detection has to happen BEFORE delivery so a swap can
        // suppress the "you hit your limit" TTS/desktop notification instead
        // of racing it (design.md Decision 2). Only a session-scoped,
        // rate-limit-shaped notification is a candidate — every other
        // notification still delivers synchronously exactly as before, so
        // this cannot change timing for the common case.
        if (event.session_id && isRateLimitNotification(event)) {
          tryReactiveRateLimitSwap(event.session_id, db, getCredentialPool)
            .then((handled) => {
              if (!handled) deliver();
            })
            .catch((err: unknown) => {
              log.warn(
                { err, sessionId: event.session_id },
                "socket: reactive rate-limit swap failed unexpectedly — delivering notification",
              );
              deliver();
            });
        } else {
          deliver();
        }
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

      case "tool_use_end": {
        // nx-9qsmb.5 (Option B): the highest-frequency socket event during a
        // live session (every Write/Edit/MultiEdit). Routed through the
        // shared processHookEvent spine — same shape as agent_spawn above —
        // so nx-qayeb.1's context-usage collector runs on tool-call cadence
        // instead of only at session boundaries. Deliberately NOT given its
        // own log.info line: at this frequency a dedicated info-level log
        // per tool call would be pure noise (unlike agent_spawn/hook_failure,
        // which are comparatively rare); processHookEvent's own enrichment
        // steps already log at debug/warn as appropriate.
        if (event.session_id) {
          processHookEvent(
            {
              eventType: "tool_use_end",
              sessionId: event.session_id,
              payload: event as unknown as Record<string, unknown>,
              source: "socket",
            },
            { sessionManager, db: db ?? null },
          ).catch((err: unknown) => {
            log.warn(
              { err, sessionId: event.session_id },
              "socket: processHookEvent(tool_use_end) rejected unexpectedly",
            );
          });
        }
        break;
      }

      case "user_prompt": {
        // nx-9qsmb.5 (Option B): the other high-frequency event (every user
        // turn), wired for the same context-usage-collector reason as
        // tool_use_end above. Same no-dedicated-log-line rationale.
        if (event.session_id) {
          processHookEvent(
            {
              eventType: "user_prompt",
              sessionId: event.session_id,
              payload: event as unknown as Record<string, unknown>,
              source: "socket",
            },
            { sessionManager, db: db ?? null },
          ).catch((err: unknown) => {
            log.warn(
              { err, sessionId: event.session_id },
              "socket: processHookEvent(user_prompt) rejected unexpectedly",
            );
          });
        }
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
// Reactive rate-limit swap (wire-reactive-rate-limit-swap, tasks 2.2/2.3)
// ---------------------------------------------------------------------------

/** Case-insensitive phrase set matching a CC "you hit your limit" hook payload. */
const RATE_LIMIT_PHRASES = ["hit your limit", "usage limit reached"];

/** True when a notification looks like a rate-limit hit — phrase match or a structured utilization ≥ 1.0. */
function isRateLimitNotification(event: NotificationEvent): boolean {
  const msg = event.message?.toLowerCase() ?? "";
  if (RATE_LIMIT_PHRASES.some((p) => msg.includes(p))) return true;
  const utilization = event.rate_limit_event?.utilization;
  return typeof utilization === "number" && utilization >= 1.0;
}

/**
 * Any other primary, non-cooldown ("available") credential — freshest
 * (lowest `rate_limit_count`) first, excluding the currently active
 * fingerprint. Returns null when none exists, so the caller passes through
 * to normal delivery and the exhaustion ladder (proactive-swap.ts) owns it.
 */
async function findReactiveSwapCandidate(
  db: Db,
  activeFingerprint: string | null,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: credentials.id, fingerprint: credentials.fingerprint })
    .from(credentials)
    .where(and(eq(credentials.isPrimary, true), eq(credentials.status, "available")))
    .orderBy(asc(credentials.rateLimitCount));
  const candidate = rows.find((r) => r.fingerprint !== activeFingerprint);
  return candidate ? { id: candidate.id } : null;
}

/**
 * Detect + handle a reactive rate-limit swap for a `notification` socket
 * event whose caller has already confirmed `isRateLimitNotification`.
 * Resolves `true` when this path owns delivery (the raw notification stays
 * suppressed); `false` to fall through to normal delivery unchanged.
 */
async function tryReactiveRateLimitSwap(
  sessionId: string,
  db: Db | undefined,
  getCredentialPool: (() => CredentialPool | null) | undefined,
): Promise<boolean> {
  if (!db || !getCredentialPool) return false;

  if (isDebounced(sessionId)) {
    // Inside the 180s window: auto-continue only — no usage query, no
    // re-swap (task 2.4). The raw notification stays suppressed; a swap
    // already handled this session's window.
    const result = await sendTextToSession(sessionId, "continue");
    if (!result.ok) {
      log.warn(
        { sessionId, error: result.error },
        "reactive-swap: debounced auto-continue failed",
      );
    }
    return true;
  }

  const pool = getCredentialPool();
  if (!pool) return false;

  const activeFingerprint = getActiveCredentialSnapshot().fingerprint;
  const candidate = await findReactiveSwapCandidate(db, activeFingerprint);
  if (!candidate) return false; // no eligible candidate — exhaustion ladder owns it

  let outcome: Awaited<ReturnType<typeof performCredentialSwap>>;
  try {
    outcome = await performCredentialSwap({
      db,
      pool,
      targetId: candidate.id,
      reason: "reactive",
      sessionId,
    });
  } catch (err) {
    log.warn(
      { err, sessionId, targetId: candidate.id },
      "reactive-swap: performCredentialSwap threw",
    );
    return false; // fall through to normal delivery
  }
  if (!outcome.ok) return false;

  const fromFingerprint = outcome.result?.parked?.fingerprint;
  if (fromFingerprint) recordFailure(fromFingerprint, 429);

  armDebounce(sessionId);

  const sendResult = await sendTextToSession(sessionId, "continue");
  if (!sendResult.ok) {
    log.warn(
      { sessionId, error: sendResult.error },
      "reactive-swap: auto-continue failed — swap stands",
    );
  }

  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pane-based session correlation for `session_start` (reconcile-session-id-
 * universes, tasks 2.1/2.2/2.3). Attempts to link this hook-sourced event to
 * an existing, not-yet-linked process-watcher row (Universe 1) via the
 * hook's `tmux_target` (raw `%N` pane-id), so the two "session universes"
 * merge into one row instead of `handleWatcherEvent` creating a second,
 * UUID-keyed row.
 *
 * Returns the row id that every downstream, session-id-keyed write (git
 * origin, model, cwd backfill, credential binding) MUST target:
 *
 * **Match found**: writes `event.session_id` onto the matched row's
 * `cc_session_id` column via `updateSessionCcSessionId`, does NOT call
 * `handleWatcherEvent` (no second row is created for this session), and
 * resolves to the MATCHED ROW'S id — not `event.session_id`, which no row
 * carries in this branch.
 *
 * **No match** (no `tmux_target` on the event, no `db` configured, the pane-
 * translation lookup misses, no matching DB row, or any lookup step throws):
 * falls back to TODAY'S UNCHANGED BEHAVIOR — calls `handleWatcherEvent`
 * exactly as before and resolves to `event.session_id` (the id
 * `handleWatcherEvent` creates the row under). This is a strict regression
 * guard (design.md § Fix, Non-Goals): the new path can only ADD correlation,
 * never leave an unmatched session worse off than it is today, which is why
 * lookup failures are caught here and folded into the same fallback rather
 * than left to reject the returned promise (that would skip both the
 * `handleWatcherEvent` call AND the downstream writes the caller chains off
 * this promise).
 *
 * The two decisions (call `handleWatcherEvent` vs. correlate instead) can
 * never race: both awaits below resolve before either branch runs.
 */
async function resolveSessionStartTarget(
  event: SessionStartEvent,
  watcherEvent: WatcherEvent,
  sessionManager: SessionManager,
  db: Db | undefined,
): Promise<string> {
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
          return matched.id;
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
  return event.session_id;
}

/**
 * Find the most-recently-active `active`/`idle` session row matching a
 * translated tmux `session:window.pane` address, excluding rows that already
 * carry a `cc_session_id` (idempotency — a repeat session_start/heartbeat-
 * shaped event for an already-correlated session must not re-match or
 * double-write). Picks the most recent `last_activity` when multiple rows
 * match a reused pane. Task 2.1 (reconcile-session-id-universes).
 *
 * **Liveness requirement**: `status IN (active, idle)` alone is not
 * sufficient — that column can be stale/racy (a session's own end-of-life
 * status transition can lose a race against a new session_start event
 * correlating onto it, binding a brand-new session's identity onto a dead,
 * unrelated row — see the `dispatcher-pid-liveness` fix). A candidate row is
 * only returned if its `pid` is CURRENTLY alive (checked via `isPidAlive`,
 * the same `/proc/{pid}` probe `session-manager.ts` uses for its own startup
 * recovery). A row whose pid is null/non-positive is treated as
 * unverifiable and skipped — every real candidate reaching this query has a
 * `tmux_target`, which only process-watcher-managed rows carry, and those
 * always have a real positive pid.
 *
 * Fetches a small batch (not just the single freshest row) and walks it in
 * `last_activity` order so a dead freshest-by-timestamp row doesn't block an
 * older-but-still-alive candidate from matching — mirroring
 * `process-watcher.ts`'s own reconciliation pattern of fetching candidate
 * rows and filtering by an external liveness check in application code
 * rather than encoding liveness into the SQL WHERE clause.
 */
async function findUnlinkedSessionByTmuxTarget(
  db: Db,
  tmuxTarget: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: sessions.id, pid: sessions.pid })
    .from(sessions)
    .where(
      and(
        eq(sessions.tmuxTarget, tmuxTarget),
        inArray(sessions.status, ["active", "idle"]),
        or(isNull(sessions.ccSessionId), eq(sessions.ccSessionId, "")),
      ),
    )
    .orderBy(desc(sessions.lastActivity))
    .limit(5);

  for (const row of rows) {
    if (row.pid != null && row.pid > 0 && isPidAlive(row.pid)) {
      return { id: row.id };
    }
  }
  return null;
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

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

/**
 * Exposes `findUnlinkedSessionByTmuxTarget` for direct, live-PG integration
 * testing (reconcile-session-id-universes, task 3.2). The dispatcher-level
 * `session_start` correlation branching (match found -> `handleWatcherEvent`
 * skipped; no match -> unchanged fallback) is fully exercisable through the
 * public `dispatch()` entry point with a mocked `db`/`fetchPaneTranslationMap`
 * (see `dispatcher.test.ts`). But this function's own WHERE-clause semantics
 * — excluding already-`cc_session_id`-linked rows, and picking the
 * most-recently-active row when multiple share a `tmux_target` — are
 * properties of the actual SQL Drizzle builds, which a hand-rolled mock `db`
 * chain cannot genuinely exercise (it would just echo back whatever the test
 * feeds it). Exporting the function lets those two cases run as real
 * queries against a scratch schema, mirroring `process-watcher.ts`'s own
 * `__testing` export + live-PG suite for the equivalent class of behavior.
 */
export const __testing = {
  findUnlinkedSessionByTmuxTarget,
};
