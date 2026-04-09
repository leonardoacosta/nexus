import { describe, test, expect } from "bun:test";
import { msUntilDailyAt, msUntilWeeklyAt } from "./cron";

describe("cron scheduling", () => {
  describe("msUntilDailyAt", () => {
    test("returns positive ms for a time later today", () => {
      const ms = msUntilDailyAt(23, 59);
      // Unless it is exactly 23:59, this should be positive.
      expect(ms).toBeGreaterThan(0);
      // Should be less than 24 hours.
      expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    });

    test("returns ms for next day when time has passed", () => {
      // 00:00 has almost certainly passed (tests don't run at midnight).
      // If by some chance it hasn't, the result would still be valid (<24h).
      const ms = msUntilDailyAt(0, 0);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    });

    test("schedules for tomorrow when current time equals target", () => {
      // Simulate: if we call msUntilDailyAt with the current hour/minute,
      // the target <= now (seconds/ms make it pass), so it should be ~24h.
      const now = new Date();
      const ms = msUntilDailyAt(now.getHours(), now.getMinutes());

      // Since the function sets seconds/ms to 0, and now has non-zero seconds,
      // target.getTime() <= now.getTime() is true, so it schedules tomorrow.
      // Result should be close to 24 hours (minus a few seconds).
      const twentyThreeHours = 23 * 60 * 60 * 1000;
      const twentyFourHours = 24 * 60 * 60 * 1000;
      expect(ms).toBeGreaterThan(twentyThreeHours);
      expect(ms).toBeLessThanOrEqual(twentyFourHours);
    });

    test("result is always between 0 and 24 hours", () => {
      // Test a variety of times.
      for (let h = 0; h < 24; h += 6) {
        for (let m = 0; m < 60; m += 15) {
          const ms = msUntilDailyAt(h, m);
          expect(ms).toBeGreaterThan(0);
          expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
        }
      }
    });
  });

  describe("msUntilWeeklyAt", () => {
    test("returns positive ms for Sunday 09:00", () => {
      const ms = msUntilWeeklyAt(0, 9, 0); // 0 = Sunday
      expect(ms).toBeGreaterThan(0);
      // Should be at most 7 days.
      expect(ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    });

    test("returns ms within 7 days for any day/time", () => {
      for (let day = 0; day <= 6; day++) {
        const ms = msUntilWeeklyAt(day, 12, 0);
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
      }
    });

    test("schedules next week when today is the target day and time has passed", () => {
      const now = new Date();
      const currentDay = now.getDay();

      // Use a time that has already passed today (00:00 if not midnight).
      const ms = msUntilWeeklyAt(currentDay, 0, 0);
      // Should be close to 7 days from now (minus a few seconds/minutes for
      // the time already elapsed past midnight).
      const sixDays = 6 * 24 * 60 * 60 * 1000;
      expect(ms).toBeGreaterThan(sixDays);
      expect(ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    });

    test("returns less than 7 days for a future day this week", () => {
      const now = new Date();
      const currentDay = now.getDay();
      // Pick a day later this week (wrapping around is fine since mod 7).
      const futureDay = (currentDay + 3) % 7;

      const ms = msUntilWeeklyAt(futureDay, 12, 0);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    });
  });
});
