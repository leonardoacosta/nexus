/**
 * Failure-safe tmux cleanup for live-tmux integration/e2e tests (nx-8kdie).
 *
 * Integration tests that spawn REAL tmux windows/sessions leak them into the
 * user's live tmux whenever a run is killed mid-test (afterAll-only cleanup is
 * fragile — a crash before afterAll never fires it). These helpers make the
 * cleanup FAILURE-SAFE and SELF-HEALING:
 *
 *   - `sweepTmuxWindowsByPrefix(prefix)` — kill every tmux WINDOW (across all
 *     sessions) whose name starts with `prefix`, skipping the currently-active
 *     window. Used as a `beforeAll` orphan sweep (self-heals leaks from prior
 *     killed runs), an `afterEach` per-test sweep (a mid-suite crash leaks at
 *     most the window created since the last test), and an `afterAll`
 *     belt-and-suspenders final sweep.
 *
 *   - `sweepTmuxSessionsByPrefix(prefix)` — kill every tmux SESSION whose name
 *     starts with `prefix`. The session-level analogue for the e2e suites that
 *     create whole `tmux new-session` sessions rather than windows.
 *
 * CRITICAL — match by exact window NAME prefix, but KILL by the STABLE
 * `#{window_id}` (e.g. `@5`), never by a captured index. tmux RENUMBERS window
 * indices when one is removed, so a `session:index` target captured in a
 * snapshot points at the WRONG window after the first kill (this exact mistake
 * leaked windows before). `#{window_id}` is a unique, monotonic handle that
 * NEVER renumbers, so each kill in the snapshot stays correct regardless of
 * how many siblings were already removed. We also SKIP `#{window_active} == 1`
 * so we never kill the window the user is sitting in.
 *
 * All helpers are best-effort: tmux missing, no server running, or a window
 * already gone are all non-fatal. They return the count of things killed so a
 * test can assert on the sweep if it wants to.
 */

function tmuxLines(args: string[]): string[] {
  const proc = Bun.spawnSync(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return []; // no server / no sessions / tmux missing
  return proc.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function tmuxKill(args: string[]): boolean {
  const proc = Bun.spawnSync(["tmux", ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exitCode === 0;
}

/**
 * Kill every tmux WINDOW (across ALL sessions) whose name starts with `prefix`,
 * SKIPPING the currently-active window. Matches by NAME (`#{window_name}`) and
 * kills by the STABLE `#{window_id}` (`@N`) — never by index, which renumbers
 * on removal and would point at the wrong window after the first kill.
 *
 * @returns number of windows killed.
 */
export function sweepTmuxWindowsByPrefix(prefix: string): number {
  // `-a` lists windows across every session. `#{window_id}` is the stable
  // unique handle we kill by; `#{window_name}` is the prefix-match key;
  // `#{window_active}` guards the user's current window.
  const lines = tmuxLines([
    "list-windows",
    "-a",
    "-F",
    "#{window_id}|#{window_name}|#{window_active}",
  ]);
  let killed = 0;
  for (const line of lines) {
    const [windowId, name, active] = line.split("|");
    if (!windowId || !name) continue;
    if (active === "1") continue; // never kill the window the user is in
    if (!name.startsWith(prefix)) continue;
    // Kill by the STABLE window id (`@N`), so prior kills renumbering the
    // session's indices can never make this target resolve to a bystander.
    if (tmuxKill(["kill-window", "-t", windowId])) killed++;
  }
  return killed;
}

/**
 * Kill every tmux SESSION whose name starts with `prefix`. Session-level
 * analogue of {@link sweepTmuxWindowsByPrefix} for e2e suites that create whole
 * `tmux new-session` sessions. Matches by NAME, never index.
 *
 * @returns number of sessions killed.
 */
export function sweepTmuxSessionsByPrefix(prefix: string): number {
  const names = tmuxLines(["list-sessions", "-F", "#{session_name}"]);
  let killed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    if (tmuxKill(["kill-session", "-t", name])) killed++;
  }
  return killed;
}
