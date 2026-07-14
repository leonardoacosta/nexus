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

/**
 * Thrown by {@link execText}/{@link execJson} when the global spawn budget's
 * wait queue is already at its cap — the caller is rejected immediately
 * ("fail fast") instead of enqueuing yet another closure. Every subprocess
 * consumer in the agent already degrades a thrown exec error to its null/[]
 * contract (bead-rollup rollups → null, fan-out → warn+exclude, single-project
 * routes → []), so an overflow surfaces as "this project contributed nothing"
 * rather than an unbounded memory pile-up of pending closures (nx-veo5g.2 #3).
 */
export class SpawnQueueOverflowError extends Error {
  constructor(
    public readonly concurrency: number,
    public readonly queueMax: number,
  ) {
    super(
      `subprocess spawn queue overflow: ${concurrency} in flight and queue ` +
        `cap ${queueMax} reached — failing fast to the degradable null/[] contract`,
    );
    this.name = "SpawnQueueOverflowError";
  }
}

// ---------------------------------------------------------------------------
// Default timeout
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Subprocess spawn gate — two nested semaphores, one coherent mechanism
// (nx-b6trw / nx-veo5g.2 / nx-veo5g.3)
//
// Every heavyweight subprocess in the agent (bd/dolt, pgrep, openspec, git,
// tailscale, tmux, gh, which) is spawned through `execText`/`execJson` below,
// so this file is the single choke point for a process-wide budget.
//
//   1. GLOBAL budget (globalSpawnSemaphore) — a coarse ceiling on the TOTAL
//      number of concurrent subprocess spawns, plus a BOUNDED wait queue.
//      Sized to the cgroup so additive pressure from every timer service
//      (process-watcher's pgrep BFS, git-observer batches, spec-watcher's
//      `openspec show`, tailscale-presence) can never explode past the
//      MemoryHigh throttle (nx-veo5g.3 #1). The queue cap fails fast on
//      overflow instead of pinning hundreds of pending closures (nx-veo5g.2 #3).
//
//   2. bd/dolt sub-limit (bdDoltSemaphore) — a TIGHTER cap nested INSIDE the
//      global budget, because `bd` (and the `dolt` it shells out to) is a Go
//      binary that (a) crashes with `pthread_create failed` under thread
//      pressure and (b) buffers large `--json` blobs (one `list --all`
//      measured at 184MB peak RSS). It is the memory-heavy family, so it stays
//      capped at 4 regardless of how large the global budget is — this is the
//      "per-family weight" the sustainable-architecture proposal called for.
//
// Deadlock-freedom: a slot is held ONLY for the duration of a single
// subprocess — no caller callback runs while a slot is held, and callers chain
// `execText` sequentially (never nested), so no cycle can form. Acquisition is
// always ordered global -> bd/dolt and released in reverse via `finally`.
// ---------------------------------------------------------------------------

/** Coarse process-wide ceiling on concurrent subprocess spawns. */
export const GLOBAL_SPAWN_MAX_CONCURRENT = Number(
  process.env.GLOBAL_SPAWN_MAX_CONCURRENT ?? 12,
);

/**
 * Max callers allowed to WAIT for a global slot before new arrivals fail
 * fast. Generous enough that normal bounded fan-out (≤8) plus background
 * tickers never trip it, low enough that a runaway can't pin hundreds of
 * closures. Overflow throws {@link SpawnQueueOverflowError}.
 */
export const GLOBAL_SPAWN_QUEUE_MAX = Number(
  process.env.GLOBAL_SPAWN_QUEUE_MAX ?? 128,
);

/** Tighter sub-limit for the memory-heavy bd/dolt family (nested in global). */
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

/**
 * FIFO async semaphore with a BOUNDED wait queue. Identical to {@link Semaphore}
 * except `acquire()` rejects with {@link SpawnQueueOverflowError} once the queue
 * is at `queueMax`, so an unbounded fan-out fails fast instead of enqueuing
 * indefinitely.
 */
class BoundedSemaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];
  private readonly concurrency: number;
  private readonly queueMax: number;

  constructor(concurrency: number, queueMax: number) {
    this.concurrency = concurrency;
    this.available = concurrency;
    this.queueMax = queueMax;
  }

  /** Resolves once a slot is free; rejects immediately if the queue is full. */
  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    if (this.queue.length >= this.queueMax) {
      return Promise.reject(
        new SpawnQueueOverflowError(this.concurrency, this.queueMax),
      );
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

  /** Slots currently held (calls past the gate, mid-spawn). */
  get inFlight(): number {
    return this.concurrency - this.available;
  }

  /** Callers currently blocked waiting for a slot. */
  get queueDepth(): number {
    return this.queue.length;
  }
}

// `let`, not `const`, purely so the test-only reconfiguration seams below can
// swap in a small-capacity gate to exercise overflow deterministically. In
// production it is constructed exactly once from the env-derived constants.
let globalSpawnSemaphore = new BoundedSemaphore(
  GLOBAL_SPAWN_MAX_CONCURRENT,
  GLOBAL_SPAWN_QUEUE_MAX,
);

/** Test-only diagnostic — current count of in-flight gated subprocess calls. */
export function __getBdDoltInFlightForTest(): number {
  return bdDoltSemaphore.inFlight;
}

/** Test-only diagnostic — in-flight count against the global spawn budget. */
export function __getGlobalInFlightForTest(): number {
  return globalSpawnSemaphore.inFlight;
}

/** Test-only diagnostic — callers queued behind the global spawn budget. */
export function __getGlobalQueueDepthForTest(): number {
  return globalSpawnSemaphore.queueDepth;
}

/**
 * Test-only seam — rebuild the global spawn gate with tiny limits so the
 * queue-overflow fail-fast path can be exercised deterministically without
 * spawning hundreds of real subprocesses. Pair with
 * {@link __resetGlobalSpawnGateForTest} in a `finally`.
 */
export function __configureGlobalSpawnGateForTest(
  concurrency: number,
  queueMax: number,
): void {
  globalSpawnSemaphore = new BoundedSemaphore(concurrency, queueMax);
}

/** Test-only seam — restore the production-default global spawn gate. */
export function __resetGlobalSpawnGateForTest(): void {
  globalSpawnSemaphore = new BoundedSemaphore(
    GLOBAL_SPAWN_MAX_CONCURRENT,
    GLOBAL_SPAWN_QUEUE_MAX,
  );
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

  // Acquire the coarse process-wide budget first. This may reject with
  // SpawnQueueOverflowError (fail fast) — nothing is held yet, so there is
  // nothing to release on that path.
  await globalSpawnSemaphore.acquire();

  try {
    if (gated) {
      // Tighter nested sub-limit for the memory-heavy bd/dolt family. Unbounded
      // wait here is safe: at most GLOBAL_SPAWN_MAX_CONCURRENT callers can ever
      // be past the global gate, so this queue is implicitly bounded. The
      // per-call timeout below starts AFTER both slots are acquired, so queued
      // callers never time out merely for having waited.
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
  } finally {
    globalSpawnSemaphore.release();
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
