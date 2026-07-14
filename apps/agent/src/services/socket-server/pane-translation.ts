/**
 * Pane-translation helper — maps a tmux pane's raw `%N` pane-id to its
 * canonical `<session>:<window>.<pane>` address.
 *
 * Sibling to `process-watcher.ts`'s own private `listTmuxPanes` — NOT a
 * duplicate. `listTmuxPanes` scans `pane_pid|pane_current_path|session_name|
 * window_index|pane_index|pane_current_command` to build a
 * `Map<claudePid, PaneInfo>` for the process watcher's PID-based join. This
 * module scans `pane_id|session_name:window_index.pane_index` to build a
 * `Map<%N pane-id, session:window.pane>` for the socket dispatcher's
 * `session_start` correlation check (task 2.1), which only has the hook's
 * `$TMUX_PANE` (`%N` form) to key off of — a different input, a different
 * consumer, hence a separate small file rather than an addition to
 * `process-watcher.ts`.
 *
 * See: `openspec/changes/reconcile-session-id-universes/design.md` § Fix.
 */

import { createLogger } from "@nexus/core/node";
import { execText } from "../../utils/exec";

const log = createLogger("agent:socket-server:pane-translation");

/**
 * Format string for `tmux list-panes -a`. Chosen so the raw `%N` pane-id
 * (`#{pane_id}`) is paired with the canonical `<session>:<window>.<pane>`
 * address on one line, separated by `|` — mirrors `listTmuxPanes`'s own
 * field-separated approach (no shell quoting to worry about).
 */
const TMUX_PANE_TRANSLATION_FORMAT =
  "#{pane_id}|#{session_name}:#{window_index}.#{pane_index}";

/**
 * Parse raw `tmux list-panes -a -F '#{pane_id}|#{session_name}:#{window_index}.#{pane_index}'`
 * stdout into a `Map<string, string>` from the raw `%N` pane-id to its
 * `session:window.pane` address.
 *
 * Pure and synchronous — no subprocess, no I/O. Malformed or empty lines
 * (missing the `|` separator, a blank pane-id, or a blank address) are
 * skipped, never thrown on. Empty input returns an empty map.
 */
export function parsePaneTranslationOutput(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sepIdx = trimmed.indexOf("|");
    if (sepIdx <= 0) continue;
    const paneId = trimmed.slice(0, sepIdx).trim();
    const address = trimmed.slice(sepIdx + 1).trim();
    if (!paneId || !address) continue;
    out.set(paneId, address);
  }
  return out;
}

/**
 * Run `tmux list-panes -a -F '#{pane_id}|#{session_name}:#{window_index}.#{pane_index}'`
 * and translate the result via {@link parsePaneTranslationOutput}.
 *
 * Fail-soft, mirroring `process-watcher.ts`'s own `listTmuxPanes`: no tmux
 * server reachable, a non-zero exit, or any other spawn failure yields an
 * empty map — never throws.
 */
export async function fetchPaneTranslationMap(): Promise<Map<string, string>> {
  let stdout: string;
  try {
    // The format string's `#{…}` placeholders trip safeSpawn's shell-
    // metacharacter guard (same reasoning as `listTmuxPanes`): it's a
    // hard-coded constant in this file with no user-controlled input, so
    // trustArgs only opts out of the arg-content check, not the `tmux`
    // binary allowlist.
    stdout = await execText(
      "tmux",
      ["list-panes", "-a", "-F", TMUX_PANE_TRANSLATION_FORMAT],
      { trustArgs: true },
    );
  } catch (err) {
    log.info(
      { error: err instanceof Error ? err.message : String(err) },
      "tmux list-panes failed; pane translation unavailable this call",
    );
    return new Map();
  }

  return parsePaneTranslationOutput(stdout);
}
