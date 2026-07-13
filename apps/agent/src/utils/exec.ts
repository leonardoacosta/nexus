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
// bd/dolt concurrency gate (nx-b6trw)
//
// `bd` (and the `dolt` it shells out to internally) is a Go binary that
// crashes with `pthread_create failed` under host-wide thread/memory
// pressure. Bounding how many `bd`/`dolt` subprocesses nexus-agent spawns
// concurrently keeps our own fan-out from compounding that pressure.
// ---------------------------------------------------------------------------

export const BD_DOLT_MAX_CONCURRENT = Number(process.env.BD_DOLT_MAX_CONCURRENT ?? 4);

/**
 * Commands gated by {@link bdDoltSemaphore}. Exported (not a private
 * constant) so tests can temporarily register a stand-in command name —
 * `bd`/`dolt` aren't installed in the test sandbox, so concurrency tests
 * exercise the gate via a substitute like `sh`.
 */
export const GATED_COMMANDS = new Set(["bd", "dolt"]);

export function isGatedCommand(cmd: string): boolean {
  return GATED_COMMANDS.has(cmd);
}

/** Minimal FIFO async semaphore: a counter plus a queue of resolvers. */
class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];
  private readonly concurrency: number;

  constructor(concurrency: number) {
    this.concurrency = concurrency;
    this.available = concurrency;
  }

  /** Resolves once a slot is free. Unbounded wait — that's the intended backpressure. */
  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /** Hand the freed slot to the next waiter (if any), else return it to the pool. */
  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }

  /** Number of slots currently held (i.e. calls past the gate, mid-spawn). */
  get inFlight(): number {
    return this.concurrency - this.available;
  }
}

const bdDoltSemaphore = new Semaphore(BD_DOLT_MAX_CONCURRENT);

/** Test-only diagnostic — current count of in-flight gated subprocess calls. */
export function __getBdDoltInFlightForTest(): number {
  return bdDoltSemaphore.inFlight;
}

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
  const gated = isGatedCommand(cmd);

  if (gated) {
    // Unbounded wait for a slot — the queue itself is the backpressure.
    // The per-call timeout below starts AFTER the slot is acquired, so
    // queued callers never time out merely for having waited.
    await bdDoltSemaphore.acquire();
  }

  try {
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
  } finally {
    if (gated) {
      bdDoltSemaphore.release();
    }
  }
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
