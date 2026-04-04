/**
 * Project detection and session ID resolution.
 *
 * Extracts project code from CWD and resolves session ID from
 * environment variables or a stable hash fallback.
 */

import { createHash } from "crypto";

/**
 * Detect the project code from the current working directory.
 * Extracts the final directory name (e.g., `/home/user/dev/co` -> `co`).
 */
export function detectProject(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? "unknown";
}

/**
 * Resolve the session ID.
 *
 * 1. If `CLAUDE_SESSION_ID` env var is set, use it.
 * 2. Otherwise, generate a stable ID from PID + CWD hash.
 */
export function resolveSessionId(): string {
  const envId = process.env.CLAUDE_SESSION_ID;
  if (envId) return envId;

  // Stable fallback: hash of PID + CWD
  const pid = process.ppid?.toString() ?? process.pid.toString();
  const cwd = process.cwd();
  const hash = createHash("sha256")
    .update(`${pid}:${cwd}`)
    .digest("hex")
    .slice(0, 16);
  return `gen-${hash}`;
}
