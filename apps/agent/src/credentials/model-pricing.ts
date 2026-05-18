export interface ModelPricing {
  /** $ per 1M input tokens */
  inputRate: number;
  /** $ per 1M output tokens */
  outputRate: number;
  /** $ per 1M cache read tokens */
  cacheReadRate: number;
  /** $ per 1M cache creation tokens */
  cacheCreationRate: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── Claude 4.6 ──
  "claude-opus-4-6": {
    inputRate: 15,
    outputRate: 75,
    cacheReadRate: 1.5,
    cacheCreationRate: 18.75,
  },
  "claude-sonnet-4-6": {
    inputRate: 3,
    outputRate: 15,
    cacheReadRate: 0.3,
    cacheCreationRate: 3.75,
  },

  // ── Claude 4.5 ──
  "claude-haiku-4-5-20251001": {
    inputRate: 0.8,
    outputRate: 4,
    cacheReadRate: 0.08,
    cacheCreationRate: 1,
  },

  // ── Claude 3.5 ──
  "claude-3-5-sonnet-20241022": {
    inputRate: 3,
    outputRate: 15,
    cacheReadRate: 0.3,
    cacheCreationRate: 3.75,
  },
  "claude-3-5-haiku-20241022": {
    inputRate: 0.8,
    outputRate: 4,
    cacheReadRate: 0.08,
    cacheCreationRate: 1,
  },

  // ── Claude 3 ──
  "claude-3-opus-20240229": {
    inputRate: 15,
    outputRate: 75,
    cacheReadRate: 1.5,
    cacheCreationRate: 18.75,
  },
  "claude-3-sonnet-20240229": {
    inputRate: 3,
    outputRate: 15,
    cacheReadRate: 0.3,
    cacheCreationRate: 3.75,
  },
  "claude-3-haiku-20240307": {
    inputRate: 0.25,
    outputRate: 1.25,
    cacheReadRate: 0.03,
    cacheCreationRate: 0.3,
  },
} as const satisfies Record<string, ModelPricing>;

/** Compute cost in USD. Returns null for unknown models. */
export function computeTokenCost(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  },
): number | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;
  return (
    (usage.inputTokens * pricing.inputRate +
      usage.outputTokens * pricing.outputRate +
      usage.cacheReadInputTokens * pricing.cacheReadRate +
      usage.cacheCreationInputTokens * pricing.cacheCreationRate) /
    1_000_000
  );
}
