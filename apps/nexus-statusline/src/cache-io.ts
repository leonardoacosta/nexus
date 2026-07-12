import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/** Shared CC state dir every statusline cache file lives in. */
export const STATE_DIR = join(homedir(), ".claude/scripts/state");

export function statePath(fileName: string): string {
  return join(STATE_DIR, fileName);
}

/**
 * Read + JSON.parse a cache file, optionally shape-validated. Fail-soft:
 * missing / unreadable / unparseable / invalid → null, never throws.
 */
export function readJsonCache<T>(
  path: string,
  validate?: (raw: unknown) => raw is T,
): T | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (validate) return validate(raw) ? raw : null;
    return raw as T;
  } catch {
    return null;
  }
}

/**
 * Atomic cache write: tmp sibling + 0o600 + rename. Fail-soft: a cache
 * write never crashes the render.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // fail-soft
  }
}
