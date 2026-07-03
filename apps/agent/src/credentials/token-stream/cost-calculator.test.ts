import { describe, expect, it } from "bun:test";
import { computeCost } from "./cost-calculator";
import { computeTokenCost } from "../model-pricing";

// The long-name usage object computeCost expects.
const usage = (i: number, o: number, cr = 0, cc = 0) => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadInputTokens: cr,
  cacheCreationInputTokens: cc,
});

describe("computeCost — known-model pricing", () => {
  it("prices 1M sonnet input tokens at $3", () => {
    expect(computeCost("claude-sonnet-4-6", usage(1_000_000, 0), "s1")).toBe(3);
  });
  it("prices a mixed sonnet turn (input+output)", () => {
    expect(computeCost("claude-sonnet-4-6", usage(1000, 1000), "s1")).toBeCloseTo(0.018, 9);
  });
  it("prices 1M opus output tokens at $75", () => {
    expect(computeCost("claude-opus-4-6", usage(0, 1_000_000), "s1")).toBe(75);
  });
  it("includes cache read + cache creation rates", () => {
    // haiku: cacheRead 0.08, cacheCreation 1 per 1M
    expect(computeCost("claude-haiku-4-5-20251001", usage(0, 0, 1_000_000, 1_000_000), "s1"))
      .toBeCloseTo(0.08 + 1, 9);
  });
  it("returns 0 (not null) for a known model with zero usage", () => {
    expect(computeCost("claude-sonnet-4-6", usage(0, 0), "s1")).toBe(0);
  });
  it("handles a very large token count", () => {
    expect(computeCost("claude-sonnet-4-6", usage(1_000_000_000, 0), "s1")).toBe(3000);
  });
});

describe("computeCost — unknown model", () => {
  it("returns null for an unrecognized model", () => {
    expect(computeCost("gpt-4o", usage(1000, 1000), "s1")).toBeNull();
  });
});

describe("computeTokenCost — pure math", () => {
  it("matches computeCost for a known model", () => {
    expect(computeTokenCost("claude-sonnet-4-6", usage(1_000_000, 0)))
      .toBe(computeCost("claude-sonnet-4-6", usage(1_000_000, 0), "s1"));
  });
  it("returns null for an unknown model", () => {
    expect(computeTokenCost("nope", usage(1, 1))).toBeNull();
  });
});
