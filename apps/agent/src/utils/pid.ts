import { existsSync } from "node:fs";

/**
 * Check whether a PID currently identifies a live process.
 *
 * On Linux this checks `/proc/{pid}` existence (cheap, no signal delivered).
 * On other platforms it falls back to `process.kill(pid, 0)`, which delivers
 * no signal but throws `ESRCH` if the process doesn't exist.
 *
 * Extracted from `session-manager.ts` (originally private to
 * `createSessionManager`'s startup-recovery path) so other call sites —
 * e.g. `dispatcher.ts`'s `findUnlinkedSessionByTmuxTarget` — can reuse the
 * same liveness check instead of re-implementing the `/proc` probe inline.
 */
export function isPidAlive(pid: number): boolean {
  if (process.platform === "linux") {
    return existsSync(`/proc/${pid}`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
