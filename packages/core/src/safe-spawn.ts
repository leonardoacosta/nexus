/**
 * safeSpawn — centralized subprocess wrapper for nexus.
 *
 * Every production call site that spawns a child process MUST go through
 * this wrapper instead of `Bun.spawn` or `child_process.spawn` directly.
 * The wrapper enforces a binary allowlist and rejects shell metacharacters
 * in args by default. Opting out requires an explicit `trustArgs: true`
 * flag, which is intentionally loud and grep-able for audit.
 *
 * See openspec/changes/finalize-audit-cleanup/design.md § Decisions 2 + 3
 * for the rationale behind the handle-returning shape and the opt-out
 * arg validation model.
 */

import type { Subprocess } from "bun";

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Allowed binaries — adding to this list is intentionally a code change,
 * not config. Each entry should be a binary that nexus needs to spawn as
 * part of its core capability (tmux harness management, project discovery,
 * terminal attach, etc.).
 */
export const ALLOWED_BINARIES = [
  "tmux", // tmux harness management — the product
  "git", // project discovery, branch detection
  "claude", // Claude Code CLI hook relay
  "ssh", // terminal attach via remote shells
  "bash", // PTY shell for interactive sessions
  "sh", // POSIX shell fallback
  "cat", // session log tailing
  "mkfifo", // create the named pipe tmux-pty-source.ts streams pane output through (plans/032)
  "nexus", // self-invocation (CLI tests, register)
  "openspec", // spec list/show for spec-watcher + specs route
  "which", // binary discovery for environment route + tmux availability check
  "pgrep", // process-watcher reconciliation — discover live `claude` PIDs
  "gh", // GitHub CLI auth status for environment route
  "bd", // beads issue tracker queries for recommend + project-detail
  "nexus-watcher", // sibling Bun-compiled binary — file system event watcher relayed by watcher-bridge
] as const;

export type AllowedBinary = (typeof ALLOWED_BINARIES)[number];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DisallowedBinaryError extends Error {
  constructor(public readonly binary: string) {
    super(
      `safeSpawn: '${binary}' is not in ALLOWED_BINARIES. ` +
        `Add it to packages/core/src/safe-spawn.ts if it is genuinely needed.`,
    );
    this.name = "DisallowedBinaryError";
  }
}

export class UnsafeArgError extends Error {
  constructor(
    public readonly arg: string,
    public readonly position: number,
  ) {
    super(
      `safeSpawn: arg ${position} contains shell metacharacters: ${JSON.stringify(arg)}. ` +
        `Pass { trustArgs: true } to opt out — make sure the input is fully validated.`,
    );
    this.name = "UnsafeArgError";
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Characters that can introduce shell injection when concatenated blindly. */
// eslint-disable-next-line no-control-regex
const SHELL_META = /[;&|$`\n\r]/;

/**
 * Validate that a string does not contain shell metacharacters.
 * Exposed for tests and for call sites that want to pre-validate before
 * deciding whether to pass `trustArgs`.
 */
export function isSafeArg(arg: string): boolean {
  return !SHELL_META.test(arg);
}

/**
 * Extract the basename of a binary path. Handles both absolute and relative
 * paths, and falls back to the input string if no separator is present.
 *
 * This is intentionally POSIX-only — nexus runs exclusively on Linux/macOS
 * agents, so we do not need to handle Windows-style backslash separators.
 */
function basename(binary: string): string {
  const idx = binary.lastIndexOf("/");
  return idx === -1 ? binary : binary.slice(idx + 1);
}

/**
 * Throw if `binary` is not in {@link ALLOWED_BINARIES}.
 *
 * Accepts both bare names (e.g. `"git"`) and absolute paths (e.g.
 * `"/opt/nexus/bin/nexus-watcher"`). The allowlist check is performed against
 * the basename so call sites that resolve binaries relative to
 * `process.execPath` (watcher-bridge) do not need to strip the directory
 * themselves.
 */
export function assertAllowedBinary(binary: string): asserts binary is AllowedBinary {
  const name = basename(binary);
  if (!(ALLOWED_BINARIES as readonly string[]).includes(name)) {
    throw new DisallowedBinaryError(binary);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type StdioMode = "pipe" | "inherit" | "ignore";

export interface SafeSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** If provided, aborting the signal calls `handle.abort()`. */
  signal?: AbortSignal;
  /**
   * Opt out of arg validation. Loud + grep-able for audit.
   * Use this ONLY when the args legitimately need shell metacharacters
   * (e.g. `bash -c "echo foo && echo bar"`) and the inputs are fully
   * validated upstream.
   */
  trustArgs?: boolean;
  /** Stdio config — defaults to ["pipe", "pipe", "pipe"]. */
  stdio?: [StdioMode, StdioMode, StdioMode];
}

/**
 * Returned by {@link safeSpawn}. This intentionally exposes the underlying
 * `Bun.Subprocess` types for stdin/stdout/stderr rather than inventing a
 * wrapper — call sites that used to call `Bun.spawn` directly can move over
 * with minimal churn.
 *
 * - `stdin` is a {@link Bun.FileSink} when `stdio[0] === "pipe"`, otherwise undefined/number
 * - `stdout`/`stderr` are `ReadableStream<Uint8Array>` when piped, otherwise undefined/number
 */
export interface SafeSpawnHandle {
  readonly pid: number;
  readonly stdin: Subprocess["stdin"];
  readonly stdout: Subprocess["stdout"];
  readonly stderr: Subprocess["stderr"];
  /** Resolves with the process exit code when the process exits. */
  readonly exitCode: Promise<number>;
  /** Send SIGTERM and await exit. Idempotent. */
  abort(): Promise<number>;
  /** Synchronously kill the process with an optional signal. */
  kill(signal?: number | NodeJS.Signals): void;
}

/**
 * Safely spawn a subprocess via `Bun.spawn`.
 *
 * Steps:
 *   1. Reject any binary not in {@link ALLOWED_BINARIES}.
 *   2. Reject any arg containing shell metacharacters unless `trustArgs`.
 *   3. Spawn via Bun and return a handle compatible with streaming callers.
 *
 * @throws {DisallowedBinaryError} if `binary` is not in the allowlist
 * @throws {UnsafeArgError} if any arg contains `; & | $ \` \n \r` and trustArgs is false
 */
export function safeSpawn(
  binary: string,
  args: string[],
  opts: SafeSpawnOptions = {},
): SafeSpawnHandle {
  // 1. Allowlist check
  assertAllowedBinary(binary);

  // 2. Arg validation
  if (!opts.trustArgs) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === undefined) continue;
      if (!isSafeArg(arg)) {
        throw new UnsafeArgError(arg, i);
      }
    }
  }

  // 3. Spawn via Bun
  const stdin = opts.stdio?.[0] ?? "pipe";
  const stdout = opts.stdio?.[1] ?? "pipe";
  const stderr = opts.stdio?.[2] ?? "pipe";

  const proc = Bun.spawn([binary, ...args], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdin,
    stdout,
    stderr,
  }) as Subprocess;

  // 4. Wire AbortSignal (optional)
  if (opts.signal) {
    if (opts.signal.aborted) {
      proc.kill();
    } else {
      opts.signal.addEventListener(
        "abort",
        () => {
          proc.kill();
        },
        { once: true },
      );
    }
  }

  return {
    pid: proc.pid,
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exitCode: proc.exited,
    async abort(): Promise<number> {
      if (!proc.killed) {
        proc.kill();
      }
      return await proc.exited;
    },
    kill(signal?: number | NodeJS.Signals): void {
      proc.kill(signal);
    },
  };
}
