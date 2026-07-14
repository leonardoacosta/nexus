/**
 * Wall-clock quiet-hours check (noise-reduction audit, 2026-07-13, plan 042).
 *
 * Pure — no I/O, no dependency on the presence system. This is the floor
 * that applies when NO presence signal exists at all (see manager.ts's
 * `applyQuietHoursIfNeeded`); it is independent of, and does not replace,
 * the presence-aware rules engine's own bedtime handling.
 */

/**
 * Return true when `now`'s local hour falls within [startHour, endHour).
 * Supports a window that wraps past midnight (startHour > endHour, e.g.
 * 22 -> 7). A zero-width window (startHour === endHour) is treated as
 * "quiet hours disabled" (always false) rather than "always quiet" or
 * "always loud" — an ambiguous configuration should not silently pick a
 * side.
 */
export function isWithinQuietHours(
  startHour: number,
  endHour: number,
  now: Date,
): boolean {
  if (startHour === endHour) return false;
  const hour = now.getHours();
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  // Wraps past midnight.
  return hour >= startHour || hour < endHour;
}
