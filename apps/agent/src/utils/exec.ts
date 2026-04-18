/**
 * Typed subprocess helpers wrapping {@link safeSpawn} from `@nexus/core`.
 *
 * Provides `execJson<T>()` and `execText()` — single-call replacements
 * for the spawn + stdout capture + parse boilerplate scattered across
 * route and service files.
 *
 * Internally delegates to `safeSpawn` so every subprocess in the agent
 * codebase goes through the same allowlist + arg validation. Call sites
 * keep their existing `execText`/`execJson` API — only the underlying
 * spawn primitive changed.
 */

import { safeSpawn, type SafeSpawnHandle } from "@nexus/core/node";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecOptions {
  cwd?: string;
  timeout?: number; // default 10_000ms
  env?: Record<string, string>;
  /**
   * Opt out of safeSpawn arg validation. Forwarded to safeSpawn.
   * Use this ONLY when the args legitimately need shell metacharacters
   * (e.g. `sh -c "foo; bar"`) and the inputs are fully validated upstream.
   */
  trustArgs?: boolean;
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
// Internal helper: read a SafeSpawnHandle to completion
// ---------------------------------------------------------------------------

interface SpawnOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Read a handle's stdout/stderr to completion and await the exit code.
 * Factored out so `execText` / `execJson` can share the "collect output"
 * step while safeSpawn exposes a streaming handle.
 */
async function awaitOutput(handle: SafeSpawnHandle): Promise<SpawnOutput> {
  const stdoutStream = handle.stdout;
  const stderrStream = handle.stderr;

  const stdoutPromise =
    stdoutStream instanceof ReadableStream
      ? new Response(stdoutStream).text()
      : Promise.resolve("");
  const stderrPromise =
    stderrStream instanceof ReadableStream
      ? new Response(stderrStream).text()
      : Promise.resolve("");

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const exitCode = await handle.exitCode;
  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Core exec
// ---------------------------------------------------------------------------

/**
 * Spawn a subprocess via {@link safeSpawn}, capture stdout as text, and
 * throw on non-zero exit or timeout.
 */
export async function execText(
  cmd: string,
  args: string[],
  opts?: ExecOptions,
): Promise<string> {
  const timeoutMs = opts?.timeout ?? DEFAULT_TIMEOUT_MS;

  const handle = safeSpawn(cmd, args, {
    cwd: opts?.cwd,
    env: opts?.env,
    trustArgs: opts?.trustArgs,
  });

  const timeoutPromise = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const result = await Promise.race([awaitOutput(handle), timeoutPromise]);

  if (result === "timeout") {
    await handle.abort();
    throw new ExecTimeoutError(cmd, args, timeoutMs);
  }

  if (result.exitCode !== 0) {
    throw new ExecError(cmd, args, result.exitCode, result.stderr);
  }

  return result.stdout;
}

/**
 * Spawn a subprocess via {@link safeSpawn}, capture stdout, and parse as
 * JSON. Throws on non-zero exit, timeout, or invalid JSON.
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
