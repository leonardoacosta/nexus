/**
 * Unit tests for the pure `isWithinQuietHours` helper (noise-reduction
 * audit 2026-07-13, plan 042). Covers non-wrapping and midnight-wrapping
 * windows (end-exclusive), plus the zero-width = disabled convention.
 */

import { describe, expect, it } from "bun:test";
import { isWithinQuietHours } from "./quiet-hours";

function atHour(hour: number): Date {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d;
}

describe("isWithinQuietHours", () => {
  it("non-wrapping window (0-7): inside at hour 3", () => {
    expect(isWithinQuietHours(0, 7, atHour(3))).toBe(true);
  });

  it("non-wrapping window (0-7): outside at hour 7 (end is exclusive)", () => {
    expect(isWithinQuietHours(0, 7, atHour(7))).toBe(false);
  });

  it("non-wrapping window (0-7): outside at hour 12", () => {
    expect(isWithinQuietHours(0, 7, atHour(12))).toBe(false);
  });

  it("wrapping window (22-7): inside at hour 23", () => {
    expect(isWithinQuietHours(22, 7, atHour(23))).toBe(true);
  });

  it("wrapping window (22-7): inside at hour 2", () => {
    expect(isWithinQuietHours(22, 7, atHour(2))).toBe(true);
  });

  it("wrapping window (22-7): outside at hour 12", () => {
    expect(isWithinQuietHours(22, 7, atHour(12))).toBe(false);
  });

  it("zero-width window (5-5): always false (disabled)", () => {
    expect(isWithinQuietHours(5, 5, atHour(5))).toBe(false);
    expect(isWithinQuietHours(5, 5, atHour(12))).toBe(false);
  });
});
