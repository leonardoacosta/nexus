/**
 * Token Stream Lifecycle
 *
 * Manages the lifecycle of per-session tail watchers: start on session_start,
 * stop on session_stop, resume on agent restart. Wires together the locator,
 * watcher, attribution, cost calculator, and persistence layers.
 */

import type { Db } from "@nexus/db";
import {
  sessions,
  credentials,
  sessionTokenTurns,
  sessionTokenWatcherState,
  eq,
  and,
  inArray,
  sql,
} from "@nexus/db";
import { createLogger } from "@nexus/core";

import { locateTranscript } from "./transcript-locator";
import { TailWatcher, type ParsedTurn } from "./tail-watcher";
import { attributeTurnToCredential } from "./attribution";
import { computeCost } from "./cost-calculator";
import { emitTokenTurnEvent } from "./events";

const log = createLogger("agent:token-stream:lifecycle");

// ---------------------------------------------------------------------------
// TokenStreamLifecycle
// ---------------------------------------------------------------------------

export class TokenStreamLifecycle {
  private watchers = new Map<string, TailWatcher>();

  constructor(private db: Db) {}

  /**
   * Start watching a session's transcript for token usage.
   *
   * Called on `session_start`. Sets the session's initial credential
   * assignment, locates the transcript file, and begins tailing.
   */
  async startWatcher(session: {
    id: string;
    cwd: string;
    ccSessionId: string;
  }): Promise<void> {
    // Guard against duplicate watchers
    if (this.watchers.has(session.id)) {
      log.debug({ sessionId: session.id }, "watcher already running");
      return;
    }

    // Set the session's initial credential from the currently-leased credential.
    // Find a currently-leased credential to attribute to this session.
    const leasedRows = await this.db
      .select({
        id: credentials.id,
        fingerprint: credentials.fingerprint,
      })
      .from(credentials)
      .where(eq(credentials.status, "leased"))
      .limit(1);

    const leased = leasedRows[0];
    if (leased) {
      await this.db
        .update(sessions)
        .set({
          credentialId: leased.id,
          credentialFingerprint: leased.fingerprint,
        })
        .where(eq(sessions.id, session.id));
    }

    // Locate the transcript file (waits up to 5s)
    const transcriptPath = await locateTranscript(session.cwd, session.ccSessionId);
    if (!transcriptPath) {
      log.info(
        { sessionId: session.id },
        "no transcript found, skipping token tracking",
      );
      return;
    }

    // Check for existing watcher state (resume case)
    const stateRows = await this.db
      .select()
      .from(sessionTokenWatcherState)
      .where(eq(sessionTokenWatcherState.sessionId, session.id))
      .limit(1);

    let byteOffset = 0;
    if (stateRows[0]) {
      byteOffset = stateRows[0].byteOffset;
    } else {
      // Insert initial watcher state
      await this.db.insert(sessionTokenWatcherState).values({
        sessionId: session.id,
        transcriptPath,
        byteOffset: 0,
        updatedAt: new Date(),
      });
    }

    // Create and start the tail watcher
    const watcher = new TailWatcher(
      transcriptPath,
      byteOffset,
      async (turns: ParsedTurn[], newByteOffset: number) => {
        await this.handleTurns(session.id, turns, newByteOffset);
      },
    );

    this.watchers.set(session.id, watcher);
    await watcher.start();

    log.info(
      { sessionId: session.id, transcriptPath, byteOffset },
      "token stream watcher started",
    );
  }

  /**
   * Stop watching a session's transcript.
   *
   * Called on `session_stop`. Stops the watcher and removes it from the map.
   */
  async stopWatcher(sessionId: string): Promise<void> {
    const watcher = this.watchers.get(sessionId);
    if (!watcher) {
      log.debug({ sessionId }, "no watcher to stop");
      return;
    }

    watcher.stop();
    this.watchers.delete(sessionId);

    log.info({ sessionId }, "token stream watcher stopped");
  }

  /**
   * Resume watchers for all active sessions on agent startup.
   *
   * Queries `session_token_watcher_state` for existing entries,
   * cross-references with active sessions, and restarts watchers
   * from stored byte offsets.
   */
  async resumeActiveWatchers(): Promise<void> {
    // Get all watcher state entries
    const watcherStates = await this.db
      .select()
      .from(sessionTokenWatcherState);

    if (watcherStates.length === 0) {
      log.debug("no watcher states to resume");
      return;
    }

    // Get active session IDs
    const sessionIds = watcherStates.map((s) => s.sessionId);
    const activeSessionRows = await this.db
      .select({
        id: sessions.id,
        cwd: sessions.cwd,
        ccSessionId: sessions.ccSessionId,
        status: sessions.status,
      })
      .from(sessions)
      .where(
        and(
          inArray(sessions.id, sessionIds),
          // Only resume for non-ended sessions
          sql`${sessions.status} != 'ended'`,
        ),
      );

    let resumed = 0;
    for (const sessionRow of activeSessionRows) {
      if (!sessionRow.cwd || !sessionRow.ccSessionId) continue;

      try {
        await this.startWatcher({
          id: sessionRow.id,
          cwd: sessionRow.cwd,
          ccSessionId: sessionRow.ccSessionId,
        });
        resumed++;
      } catch (err) {
        log.error(
          { sessionId: sessionRow.id, err },
          "failed to resume watcher",
        );
      }
    }

    log.info(
      { total: watcherStates.length, active: activeSessionRows.length, resumed },
      "watcher resume complete",
    );
  }

  /**
   * Stop all watchers (for graceful shutdown).
   */
  async stopAll(): Promise<void> {
    const ids = Array.from(this.watchers.keys());
    for (const id of ids) {
      await this.stopWatcher(id);
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Process a batch of parsed turns: attribute, compute cost, insert, and
   * update watcher state — all in a single transaction.
   *
   * Uses ON CONFLICT DO NOTHING on the UNIQUE(session_id, ts) constraint
   * so restarts that re-read the same bytes don't fail.
   */
  private async handleTurns(
    sessionId: string,
    turns: ParsedTurn[],
    newByteOffset: number,
  ): Promise<void> {
    // Aggregate deltas for the event emission
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;
    let totalCost: number | null = 0;

    const turnRows: Array<{
      sessionId: string;
      ts: Date;
      model: string;
      serviceTier: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      costUsd: string | null;
      credentialId: string | null;
      credentialFingerprint: string | null;
    }> = [];

    for (const turn of turns) {
      // Attribute turn to credential
      const attribution = await attributeTurnToCredential(
        this.db,
        sessionId,
        turn.ts,
      );

      // Compute cost
      const cost = computeCost(
        turn.model,
        {
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          cacheReadInputTokens: turn.cacheReadInputTokens,
          cacheCreationInputTokens: turn.cacheCreationInputTokens,
        },
        sessionId,
      );

      turnRows.push({
        sessionId,
        ts: turn.ts,
        model: turn.model,
        serviceTier: turn.serviceTier,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        cacheCreationInputTokens: turn.cacheCreationInputTokens,
        cacheReadInputTokens: turn.cacheReadInputTokens,
        costUsd: cost !== null ? cost.toFixed(6) : null,
        credentialId: attribution.credentialId,
        credentialFingerprint: attribution.credentialFingerprint,
      });

      // Accumulate deltas
      totalInput += turn.inputTokens;
      totalOutput += turn.outputTokens;
      totalCacheRead += turn.cacheReadInputTokens;
      totalCacheCreation += turn.cacheCreationInputTokens;
      if (cost !== null && totalCost !== null) {
        totalCost += cost;
      } else {
        totalCost = null;
      }
    }

    // Single transaction: insert turns + update watcher state
    try {
      await this.db.transaction(async (tx) => {
        // Insert turns with ON CONFLICT DO NOTHING for dedup safety
        if (turnRows.length > 0) {
          await tx
            .insert(sessionTokenTurns)
            .values(turnRows)
            .onConflictDoNothing({
              target: [sessionTokenTurns.sessionId, sessionTokenTurns.ts],
            });
        }

        // Update watcher state
        await tx
          .update(sessionTokenWatcherState)
          .set({
            byteOffset: newByteOffset,
            updatedAt: new Date(),
          })
          .where(eq(sessionTokenWatcherState.sessionId, sessionId));
      });
    } catch (err) {
      log.error(
        { sessionId, turnCount: turns.length, err },
        "failed to insert token turns",
      );
      return;
    }

    // Emit token.turn event on the lifecycle bus (task 8.1)
    const lastAttribution = turnRows[turnRows.length - 1];
    emitTokenTurnEvent({
      sessionId,
      credentialId: lastAttribution?.credentialId ?? null,
      credentialFingerprint: lastAttribution?.credentialFingerprint ?? null,
      tokensDelta: {
        input: totalInput,
        output: totalOutput,
        cacheRead: totalCacheRead,
        cacheCreation: totalCacheCreation,
      },
      costDelta: totalCost,
    });

    log.debug(
      {
        sessionId,
        turnCount: turns.length,
        newByteOffset,
        totalInput,
        totalOutput,
      },
      "token turns persisted",
    );
  }
}
