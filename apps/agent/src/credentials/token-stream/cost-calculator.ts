/**
 * Cost Calculator
 *
 * Thin wrapper around the model-pricing module that adds warn-once
 * semantics for unknown models. Each unique (sessionId, model) pair
 * logs a single WARN to avoid flooding logs during long sessions
 * using an unrecognized model.
 */

import { computeTokenCost } from "../model-pricing";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:token-stream:cost");

/** Tracks which (sessionId, model) pairs have already been warned about. */
const warnedModels = new Set<string>();

/**
 * Compute the USD cost for a turn's token usage.
 *
 * @returns Cost in USD, or null if the model is unknown (warn-once logged).
 */
export function computeCost(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  },
  sessionId: string,
): number | null {
  const cost = computeTokenCost(model, usage);

  if (cost === null) {
    const key = `${sessionId}:${model}`;
    if (!warnedModels.has(key)) {
      warnedModels.add(key);
      log.warn(
        { model, sessionId },
        "unknown model — cost_usd will be NULL",
      );
    }
  }

  return cost;
}
