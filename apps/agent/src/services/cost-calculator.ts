/**
 * Model-aware cost computation for Claude Code session telemetry.
 *
 * Rates are USD per 1M tokens. Cache-creation rates assume 1h cache write.
 * If the model is unknown, rates default to opus-4-7 and a warning is logged.
 */

import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:services:cost-calculator");

interface ModelRates {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cache-read tokens */
  cacheRead: number;
  /** USD per 1M cache-creation tokens (1h cache write) */
  cacheCreation: number;
}

const RATES: Record<string, ModelRates> = {
  "opus-4-7": { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 30 },
  "opus-4-6": { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 30 },
  "sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  "haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 },
};

const DEFAULT_KEY = "opus-4-7";

/**
 * Resolve a model identifier (which may be the full Anthropic model name like
 * `claude-opus-4-7-20260101` or a short alias) to a rates key.
 */
function resolveRatesKey(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes("opus-4-7")) return "opus-4-7";
  if (m.includes("opus-4-6")) return "opus-4-6";
  if (m.includes("sonnet-4-6")) return "sonnet-4-6";
  if (m.includes("haiku-4-5")) return "haiku-4-5";
  return null;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

/**
 * Compute the USD cost for a given token usage breakdown under the model's
 * rates. Falls back to opus-4-7 with a warn log when the model is unknown.
 */
export function computeCostUsd(
  model: string | null,
  tokens: TokenUsage,
): number {
  const key = resolveRatesKey(model);
  let rates: ModelRates;
  if (key) {
    rates = RATES[key]!;
  } else {
    log.warn(
      { model },
      "unknown model for cost computation — defaulting to opus-4-7 rates",
    );
    rates = RATES[DEFAULT_KEY]!;
  }

  const input = tokens.input ?? 0;
  const output = tokens.output ?? 0;
  const cacheRead = tokens.cacheRead ?? 0;
  const cacheCreation = tokens.cacheCreation ?? 0;

  const cost =
    (input * rates.input) / 1_000_000 +
    (output * rates.output) / 1_000_000 +
    (cacheRead * rates.cacheRead) / 1_000_000 +
    (cacheCreation * rates.cacheCreation) / 1_000_000;

  return cost;
}
