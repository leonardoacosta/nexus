import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { nowSecs, STATE_DIR, statePath, writeJsonAtomic } from "./cache-io";
import type { GitInfo } from "./types";

export function sessionContextPath(pane: string): string {
  return statePath(`session-context.${pane}.json`);
}

/**
 * Harvest the two fields cc-tmux's session-bar row needs —
 * `context_window.used_percentage` and the model family letter (the same
 * letter `modelEffortToken` computes for row one, via `modelFamilyLetter`) —
 * into a per-pane cache file (proposal §What Changes 2; the sole surviving
 * sliver of the original full-parity harvest). Keyed by `$TMUX_PANE` (tmux's
 * `#{pane_id}`, e.g. `%3`) so cc-tmux resolves the same file for the same pane.
 *
 * Gated on `$TMUX_PANE` — a no-op outside tmux. Atomic write (`.tmp` + rename),
 * fail-soft: never throws, never blocks the render. A null/undefined `usedPct`
 * (the suspicious-zero guard omitted the segment this frame) is a no-op, leaving
 * any prior good value in place rather than clobbering it with a zero. On frames
 * that pass the `usedPct` gate, the model letter is included whenever available
 * and omitted (no `model` key) when the frame carries no model; a null-`usedPct`
 * frame writes nothing at all, so the prior snapshot's letter is preserved along
 * with its pct. `git` (branch/dirty/ahead, already computed per-render at the
 * call site for the left-status segment) rides along when `getGitStatus` resolved a value;
 * `null`/`undefined` omits all three keys, so an older cc-tmux (or a fixture
 * with no git data) sees exactly the pre-existing shape — the reader treats
 * absent keys as "no data" (plan 004 cross-repo contract).
 */
export function writeSessionContext(
  usedPct: number | null | undefined,
  modelLetter: string | null | undefined,
  git?: GitInfo | null,
): void {
  const pane = process.env.TMUX_PANE;
  if (!pane || usedPct == null) return;
  const path = sessionContextPath(pane);
  writeJsonAtomic(path, {
    context_used_pct: usedPct,
    ...(modelLetter ? { model: modelLetter } : {}),
    ...(git ? { branch: git.branch, dirty: git.dirty, ahead: git.ahead } : {}),
    ts: nowSecs(),
  });
}

/** Orphaned session-context files older than this are pruned by the GC. */
const SESSION_CONTEXT_TTL_SECS = 6 * 60 * 60;

/** Injectable seams for `gcSessionContext` (deterministic in tests). */
interface GcDeps {
  dir?: string; // state dir override (tests use a tmpdir)
  random?: () => number; // 1-in-100 gate source
}

/** Per-session state-file prefixes the GC owns. All are session/pane-keyed
 * and never reused by CC, so nothing else ever unlinks them. */
const GC_STATE_PREFIXES = [
  "session-context.",
  "statusline-ctx.",
  "statusline-speed.",
] as const;

/**
 * Opportunistic GC for orphaned per-session state files — `session-context.
 * <pane>.json`, `statusline-ctx.<sessionId>.json`, and `statusline-speed.
 * <sessionId>.json`. A closed tmux pane / ended session leaves its cache
 * file(s) behind forever — neither tmux pane ids (`%N`) nor CC session ids
 * are predictably reused, so nothing else ever unlinks them. Gated behind a
 * 1-in-100 probability (mirroring `skill-list-dedup.sh`'s marker prune) so
 * the directory scan runs on ~1% of renders and is skipped entirely — no
 * scan, no stat — on the other 99%. Fail-soft: never throws, never blocks
 * the render.
 */
export function gcSessionContext(deps: GcDeps = {}): void {
  const random = deps.random ?? Math.random;
  if (Math.floor(random() * 100) !== 0) return; // 1-in-100: skip the scan
  try {
    const dir = deps.dir ?? STATE_DIR;
    const cutoff = nowSecs() - SESSION_CONTEXT_TTL_SECS;
    for (const name of readdirSync(dir)) {
      if (
        !GC_STATE_PREFIXES.some((p) => name.startsWith(p)) ||
        !name.endsWith(".json")
      ) {
        continue;
      }
      const full = join(dir, name);
      try {
        if (statSync(full).mtimeMs / 1000 < cutoff) unlinkSync(full);
      } catch {
        // a file vanishing mid-scan (concurrent render) is fine — skip it
      }
    }
  } catch {
    // fail-soft — GC never crashes the render
  }
}
