/**
 * Typed subprocess helpers wrapping Bun.spawn.
 *
 * Provides `execJson<T>()` and `execText()` — single-call replacements
 * for the spawn + stdout capture + parse boilerplate scattered across
 * route and service files.
 */

import { createLogger } from "@nexus/core";

const log = createLogger("agent:utils:exec");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecOptions {
  cwd?: string;
  timeout?: number; // default 10_000ms
  env?: Record<string, string>;
}

export class ExecError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly args: string[],
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    const stderrSnippet = stderr.length > 200 ? `${stderr.slice(0, 200)}…` : stderr;
    super(
      `Command failed: ${cmd} ${args.join(" ")} (exit ${exitCode})${stderrSnippet ? ` — ${stderrSnippet}` : ""}`,
    );
    this.name = "ExecError";
  }
}

export class ExecTimeoutError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly args: string[],
    public readonly timeoutMs: number,
  ) {
    super(`Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`);
    this.name = "ExecTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Default timeout
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Core exec
// ---------------------------------------------------------------------------

/**
 * Spawn a subprocess, capture stdout as text, and throw on non-zero exit
 * or timeout.
 */
export async function execText(
  cmd: string,
  args: string[],
  opts?: ExecOptions,
): Promise<string> {
  const timeoutMs = opts?.timeout ?? DEFAULT_TIMEOUT_MS;

  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
  });

  const timeoutPromise = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const resultPromise = (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  })();

  const result = await Promise.race([resultPromise, timeoutPromise]);

  if (result === "timeout") {
    proc.kill();
    throw new ExecTimeoutError(cmd, args, timeoutMs);
  }

  if (result.exitCode !== 0) {
    throw new ExecError(cmd, args, result.exitCode, result.stderr);
  }

  return result.stdout;
}

/**
 * Spawn a subprocess, capture stdout, and parse as JSON.
 * Throws on non-zero exit, timeout, or invalid JSON.
 */
export async function execJson<T>(
  cmd: string,
  args: string[],
  opts?: ExecOptions,
): Promise<T> {
  const stdout = await execText(cmd, args, opts);

  try {
    return JSON.parse(stdout) as T;
  } catch (err) {
    const snippet = stdout.length > 200 ? `${stdout.slice(0, 200)}…` : stdout;
    throw new Error(
      `Failed to parse JSON from ${cmd} ${args.join(" ")}: ${err instanceof Error ? err.message : String(err)} — output: ${snippet}`,
    );
  }
}
