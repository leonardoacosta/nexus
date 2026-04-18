/**
 * Token Stream Events
 *
 * Extends the lifecycle bus with a `TokenTurn` event type for real-time
 * token usage notifications. Each event carries deltas (not cumulative
 * totals) so consumers can sum them for running counters.
 */

import {
  lifecycleBus,
  type LifecycleEventMap,
  type LifecycleEventName,
} from "../../services/lifecycle-bus";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:token-stream:events");

// ---------------------------------------------------------------------------
// Event payload
// ---------------------------------------------------------------------------

export interface TokenTurnPayload {
  sessionId: string;
  credentialId: string | null;
  credentialFingerprint: string | null;
  tokensDelta: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  costDelta: number | null;
}

// ---------------------------------------------------------------------------
// Augment the lifecycle event map
// ---------------------------------------------------------------------------

// Extend the interface so the bus type-checks TokenTurn events.
declare module "../../services/lifecycle-bus" {
  interface LifecycleEventMap {
    TokenTurn: TokenTurnPayload;
  }
}

// ---------------------------------------------------------------------------
// Emit helper
// ---------------------------------------------------------------------------

/**
 * Emit a `TokenTurn` event on the lifecycle bus.
 *
 * Called by the lifecycle module after each successful batch insert.
 * The bus forwards to SSE subscribers, peer connectors, and any
 * in-process listeners.
 */
export function emitTokenTurnEvent(payload: TokenTurnPayload): void {
  log.debug(
    {
      sessionId: payload.sessionId,
      input: payload.tokensDelta.input,
      output: payload.tokensDelta.output,
    },
    "emitting token.turn event",
  );

  // Use the lifecycle bus directly. The `TokenTurn` event name is added
  // to the LifecycleEventMap via declaration merging above.
  lifecycleBus.emit(
    "TokenTurn" as LifecycleEventName,
    payload as LifecycleEventMap[LifecycleEventName],
  );
}
