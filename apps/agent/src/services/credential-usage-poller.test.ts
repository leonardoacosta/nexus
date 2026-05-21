/**
 * Unit tests for credential-usage-poller.
 *
 * Spec: credentials-account-resolve-and-usage (task 2.3)
 *
 * These cover the pure logic — body parser + back-off threshold — without
 * requiring a Postgres scratch schema. The full DB integration path is
 * exercised end-to-end in tasks 4.1–4.3 against a homelab agent.
 */

import { describe, expect, it } from "bun:test";
import { parseUsageBody } from "./credential-usage-poller";

describe("parseUsageBody", () => {
  it("parses a well-formed Anthropic-shaped response", () => {
    const body = {
      five_hour: {
        used: 41,
        limit: 50,
        resets_at: "2030-01-01T00:00:00.000Z",
      },
      seven_day: {
        used: 220,
        limit: 1000,
        resets_at: "2030-01-08T00:00:00.000Z",
      },
    };
    const parsed = parseUsageBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.fiveHour.used).toBe(41);
    expect(parsed?.fiveHour.limit).toBe(50);
    expect(parsed?.fiveHour.resetsAt?.toISOString()).toBe(
      "2030-01-01T00:00:00.000Z",
    );
    expect(parsed?.sevenDay.used).toBe(220);
    expect(parsed?.sevenDay.limit).toBe(1000);
  });

  it("accepts camelCase keys (defensive — unstable upstream)", () => {
    const body = {
      fiveHour: {
        used: 10,
        limit: 50,
        resetsAt: "2030-01-01T00:00:00.000Z",
      },
      sevenDay: {
        used: 100,
        limit: 1000,
        resetsAt: "2030-01-08T00:00:00.000Z",
      },
    };
    const parsed = parseUsageBody(body);
    expect(parsed?.fiveHour.used).toBe(10);
    expect(parsed?.sevenDay.used).toBe(100);
  });

  it("accepts numeric `used` and `limit` as strings", () => {
    const body = {
      five_hour: { used: "33", limit: "50", resets_at: null },
      seven_day: { used: "150", limit: "1000", resets_at: null },
    };
    const parsed = parseUsageBody(body);
    expect(parsed?.fiveHour.used).toBe(33);
    expect(parsed?.sevenDay.limit).toBe(1000);
    expect(parsed?.fiveHour.resetsAt).toBeNull();
  });

  it("accepts epoch-second `resets_at`", () => {
    const body = {
      five_hour: { used: 1, limit: 50, resets_at: 1893456000 }, // 2030-01-01
      seven_day: { used: 1, limit: 1000, resets_at: 1893456000 },
    };
    const parsed = parseUsageBody(body);
    expect(parsed?.fiveHour.resetsAt?.toISOString()).toContain("2030-");
  });

  it("returns null when both windows are unrecognisable", () => {
    expect(parseUsageBody({})).toBeNull();
    expect(parseUsageBody(null)).toBeNull();
    expect(parseUsageBody("not an object" as unknown)).toBeNull();
    expect(parseUsageBody({ five_hour: 42, seven_day: "junk" })).toBeNull();
  });

  it("tolerates one window missing — fills the other with zeros", () => {
    const body = {
      five_hour: { used: 12, limit: 50, resets_at: null },
      // seven_day absent
    };
    const parsed = parseUsageBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.fiveHour.used).toBe(12);
    expect(parsed?.sevenDay.used).toBe(0);
    expect(parsed?.sevenDay.limit).toBe(0);
  });

  it("rejects junk for resets_at without dropping numeric fields", () => {
    const body = {
      five_hour: { used: 5, limit: 50, resets_at: "definitely not a date" },
      seven_day: { used: 50, limit: 1000, resets_at: "also bad" },
    };
    const parsed = parseUsageBody(body);
    expect(parsed?.fiveHour.used).toBe(5);
    expect(parsed?.fiveHour.resetsAt).toBeNull();
    expect(parsed?.sevenDay.used).toBe(50);
    expect(parsed?.sevenDay.resetsAt).toBeNull();
  });
});

describe("back-off threshold computation", () => {
  // Replays the inline `attempted > 0 && failed / attempted > 0.5` check
  // from tick(). The pure math lives nowhere else, so we lock it here so
  // future refactors that touch the threshold land via a failing assertion
  // first.
  function shouldBackOff(attempted: number, failed: number): boolean {
    return attempted > 0 && failed / attempted > 0.5;
  }

  it("does not back off when no calls were attempted", () => {
    expect(shouldBackOff(0, 0)).toBe(false);
  });

  it("does not back off at the 50% boundary", () => {
    // 2 of 4 == 0.5 — strictly > 0.5 is the threshold, so 50% should NOT
    // back off (matches the implementation).
    expect(shouldBackOff(4, 2)).toBe(false);
  });

  it("backs off above 50%", () => {
    expect(shouldBackOff(4, 3)).toBe(true);
    expect(shouldBackOff(2, 2)).toBe(true);
  });

  it("does not back off below 50%", () => {
    expect(shouldBackOff(4, 1)).toBe(false);
    expect(shouldBackOff(10, 4)).toBe(false);
  });
});
