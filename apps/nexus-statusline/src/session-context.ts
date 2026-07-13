import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { nowSecs, STATE_DIR, statePath } from "./cache-io";

export function sessionContextPath(pane: string): string {
  return statePath(`session-context.${pane}.json`);
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
