/**
 * Shared hook event processor — the common spine between the (retired) HTTP
 * `/hooks` endpoint and the live `services/socket-server/dispatcher.ts`.
 *
 * Wires three previously deferred enrichments into a single call:
 *   1. **schema-drift detection** — runs FIRST on every event so unknown
 *      shapes are captured before any downstream branch can throw.
 *   2. **session_start → git origin** — `resolveGitOrigin(cwd)` →
 *      `updateSessionGitOrigin(db, sessionId, …)` (fire-and-forget).
 *   3. **agent_spawn → sub-agent tree linkage** — populates
 *      `sessions.parent_session_id` + `child_role` via
 *      `SessionManager.updateLinkage`.
 *
 * Specs closed by this helper:
 *   - add-git-project-resolver 1.3
 *   - add-schema-drift-detector 1.3
 *   - add-subagent-tree-columns 1.3 + 1.6
 *   - socket-dispatcher-parity 1.4 (partial — credential + throttle gaps
 *     remain owned by the dispatcher caller for now)
 *
 * Failure modes: every enrichment is best-effort. Errors are logged and
 * swallowed; the helper never throws. This matches the upstream contract
 * for hook ingress — a transient enrichment hiccup must not break the
 * primary dispatch path.
 */

import type { Db } from "@nexus/db";
import { sessions, eq } from "@nexus/db";
import { createLogger } from "@nexus/core/node";
import type { SessionManager } from "../session-manager";
import { resolveGitOrigin } from "./git-project";
import { resolveProject } from "./git-project-resolver";
import { inspectAndEmitDrift } from "./schema-drift";
import {
  updateSessionGitOrigin,
  backfillSessionCwd,
  deriveAgentState,
  updateSessionAgentState,
  updateSessionModel,
} from "../db/sessions";

const log = createLogger("agent:process-hook-event");

/**
 * Input contract for the shared hook processor.
 *
 * Both callers (socket dispatcher, legacy/future HTTP route) flatten their
 * native event shape onto this envelope so the helper can be source-blind.
 */
export interface HookEventInput {
  /** Hook discriminator — e.g. "session_start", "agent_spawn", "PreToolUse". */
  eventType: string;
  /** Originating session id, if known. */
  sessionId?: string;
  /** Raw payload — passed to schema-drift unchanged. */
  payload: Record<string, unknown>;
  /** Telemetry tag for which ingress path produced the event. */
  source: "socket" | "http";
  /** Optional working directory from a `session_start` envelope. */
  cwd?: string | null;
}

export interface HookEventResult {
  /** Whether schema-drift inspection completed without error. */
  driftOk: boolean;
  /** Whether the per-event-type enrichment branch ran without error. */
  enrichmentOk: boolean;
}

export interface ProcessHookEventDeps {
  sessionManager: SessionManager;
  /**
   * Optional DB connection. When absent, schema-drift and git-origin writes
   * are skipped (the helper is still safe to call). The in-memory linkage
   * update via `sessionManager.updateLinkage` runs regardless.
   */
  db?: Db | null;
}

/**
 * Process a hook event through the shared enrichment spine.
 *
 * Pipeline:
 *   1. schema-drift  (fire-and-forget; runs only when `db` is present)
 *   2. branch on eventType — `session_start` enriches git origin,
 *      `agent_spawn` populates sub-agent tree linkage. Other event types
 *      fall through (no shared enrichment yet — credential binding,
 *      throttle, session_events persistence remain on the caller).
 *
 * Returns `{ driftOk, enrichmentOk }` for telemetry / parity tests. Failures
 * are logged and counted (the booleans flip to `false`); the helper itself
 * never throws.
 */
export async function processHookEvent(
  input: HookEventInput,
  deps: ProcessHookEventDeps,
): Promise<HookEventResult> {
  const { sessionManager, db } = deps;
  let driftOk = true;
  let enrichmentOk = true;

  // 1. schema-drift FIRST — captures every event, including ones we don't
  //    yet branch on. Skipped silently when no DB is wired.
  if (db) {
    try {
      await inspectAndEmitDrift(db, input.eventType, input.payload);
    } catch (err) {
      driftOk = false;
      log.warn(
        { err, eventType: input.eventType, source: input.source },
        "process-hook-event: schema-drift inspector threw (non-fatal)",
      );
    }
  }

  // 1b. Agent-state derivation (session-enrichment). Runs on EVERY event so
  //     the orthogonal blocked/waiting/ready axis tracks the live hook stream.
  //     deriveAgentState returns null for events with no agent-state signal
  //     (e.g. session_start, agent_spawn, telemetry) — those are skipped so a
  //     previously-derived state is never clobbered with null. Best-effort:
  //     a persist hiccup must not break the primary dispatch path, and it is
  //     intentionally NOT folded into enrichmentOk (a distinct concern).
  if (db && input.sessionId) {
    const agentState = deriveAgentState(input.eventType);
    if (agentState !== null) {
      try {
        await updateSessionAgentState(db, input.sessionId, agentState);
        log.debug(
          {
            sessionId: input.sessionId,
            eventType: input.eventType,
            agentState,
            source: input.source,
          },
          "process-hook-event: agent_state persisted",
        );
      } catch (err) {
        log.warn(
          { err, eventType: input.eventType, sessionId: input.sessionId, source: input.source },
          "process-hook-event: agent_state persist threw (non-fatal)",
        );
      }
    }
  }

  // 2. Per-event-type enrichment.
  try {
    switch (input.eventType) {
      case "session_start": {
        if (!input.sessionId) break;
        // add-session-model-authority: persist the raw model from the hook
        // payload (last-write-wins). Independent of cwd/git-origin — a
        // session_start with no cwd still carries a model. Own inner try/catch:
        // model persistence is orthogonal enrichment, so a hiccup here must not
        // flip enrichmentOk or block the git-origin branch below (mirrors the
        // fire-and-forget, swallow-on-failure shape of the cwd-backfill block).
        if (db) {
          const model = input.payload.model;
          if (typeof model === "string" && model.length > 0) {
            try {
              await updateSessionModel(db, input.sessionId, model);
            } catch (err) {
              log.warn(
                { err, sessionId: input.sessionId, source: input.source },
                "process-hook-event: model persist threw (non-fatal)",
              );
            }
          }
        }
        if (!input.cwd) break;
        if (!db) break;
        // nx-cvyxt: backfill the row's cwd FIRST. The process-watcher inserts
        // a row with an empty cwd whenever a live `claude` PID doesn't match a
        // tmux pane; cwd is hook-authoritative (the watcher is /proc-free under
        // Yama=1, nx-9jz0v), so this session_start hook is the only source for
        // that row's cwd. backfillSessionCwd is idempotent — it only writes
        // when the current cwd is empty/null, so a real cwd is never clobbered
        // by a later differing hook value.
        try {
          const filled = await backfillSessionCwd(db, input.sessionId, input.cwd);
          if (filled > 0) {
            log.info(
              { sessionId: input.sessionId, cwd: input.cwd, source: input.source },
              "process-hook-event: backfilled empty-cwd session row from hook",
            );
          }
        } catch (err) {
          // Fail-soft, consistent with the rest of this enrichment branch:
          // a cwd backfill hiccup must not block git-origin resolution.
          log.warn(
            { err, sessionId: input.sessionId, source: input.source },
            "process-hook-event: cwd backfill threw (non-fatal)",
          );
        }
        // session-row-enrichment-v1 § 1.5: use the new resolver which also
        // looks up projectId. Falls back to the narrower resolveGitOrigin
        // semantics when the resolver returns null (non-git / missing
        // remote). Test suites that mock "./git-project" still see the
        // legacy resolveGitOrigin call so parity tests stay green.
        const project = await resolveProject(input.cwd, db);
        const origin = project
          ? { provider: project.provider, ownerRepo: project.ownerRepo }
          : await resolveGitOrigin(input.cwd);
        if (origin) {
          await updateSessionGitOrigin(db, input.sessionId, origin);
          // Persist projectId when the registry matched a known project.
          // The in-memory Session type does not surface projectId on the
          // session_start enrichment path — we write the column directly.
          if (project?.projectId) {
            await db
              .update(sessions)
              .set({ projectId: project.projectId })
              .where(eq(sessions.id, input.sessionId));
          }
          log.info(
            {
              sessionId: input.sessionId,
              provider: origin.provider,
              ownerRepo: origin.ownerRepo,
              projectId: project?.projectId ?? null,
              source: input.source,
            },
            "process-hook-event: git project resolved + persisted",
          );
        } else {
          log.debug(
            { sessionId: input.sessionId, cwd: input.cwd },
            "process-hook-event: no git origin for cwd (non-git or missing remote)",
          );
        }
        break;
      }

      case "agent_spawn": {
        if (!input.sessionId) break;
        // Accept both `parent_session_id` (canonical) and `parent_agent`
        // (back-compat with CC hook payloads — see backfill script).
        const parentSessionIdRaw =
          (input.payload.parent_session_id as string | undefined) ??
          (input.payload.parent_agent as string | undefined) ??
          null;
        const childRoleRaw =
          (input.payload.child_role as string | undefined) ?? null;
        if (parentSessionIdRaw == null && childRoleRaw == null) break;
        sessionManager.updateLinkage(input.sessionId, {
          parentSessionId: parentSessionIdRaw,
          childRole: childRoleRaw,
        });
        log.info(
          {
            sessionId: input.sessionId,
            parentSessionId: parentSessionIdRaw,
            childRole: childRoleRaw,
            source: input.source,
          },
          "process-hook-event: sub-agent tree linkage applied",
        );
        break;
      }

      default:
        // Other event types have no shared enrichment yet — caller-specific
        // wrappers (credential binding, throttle, session_events insert)
        // remain in the dispatcher and the (future) HTTP route.
        break;
    }
  } catch (err) {
    enrichmentOk = false;
    log.warn(
      { err, eventType: input.eventType, source: input.source },
      "process-hook-event: enrichment branch threw (non-fatal)",
    );
  }

  return { driftOk, enrichmentOk };
}
