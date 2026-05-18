/**
 * pino-db-transport — durable persistence of warn/error/fatal log records
 * into the `script_errors` table.
 *
 * Spec: openspec/changes/enforce-pino-script-errors
 *
 * Design:
 *  - Implemented as a pino "hooks.logMethod" interceptor rather than a worker
 *    thread transport so scripts that exit immediately after main() don't
 *    lose the final batch to a torn worker shutdown.
 *  - Records buffer in memory and flush every `FLUSH_INTERVAL_MS` or when the
 *    buffer reaches `BATCH_SIZE`, whichever comes first.
 *  - `flushNow()` is exposed so `withErrorCapture` can guarantee delivery
 *    before `process.exit`.
 *  - The DB handle is injected via `attachScriptErrorSink()` from script
 *    entry points so unit tests can swap in a fake sink.
 *
 * Levels captured: 40 (warn) and above. info/debug/trace are stdout-only.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export interface ScriptErrorRecord {
  id: string;
  scriptName: string;
  level: "warn" | "error" | "fatal";
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
  machine: string;
  exitCode: number | null;
  createdAt: Date;
}

export interface ScriptErrorSink {
  /** Persist a batch of records. MUST NOT throw. */
  insert(records: ScriptErrorRecord[]): Promise<void>;
}

const BATCH_SIZE = 25;
const FLUSH_INTERVAL_MS = 1_000;

const PINO_LEVELS: Record<number, "warn" | "error" | "fatal" | null> = {
  40: "warn",
  50: "error",
  60: "fatal",
};

let sink: ScriptErrorSink | null = null;
let buffer: ScriptErrorRecord[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Wire a DB-backed sink. Call once at script boot. */
export function attachScriptErrorSink(s: ScriptErrorSink): void {
  sink = s;
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      void flushNow();
    }, FLUSH_INTERVAL_MS);
    // Allow the process to exit naturally when nothing else holds the loop.
    flushTimer.unref?.();
  }
}

/** Detach + flush — useful in tests. */
export async function detachScriptErrorSink(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushNow();
  sink = null;
}

/** Drain the buffer. Always resolves. */
export async function flushNow(): Promise<void> {
  if (!sink || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    await sink.insert(batch);
  } catch (err) {
    // Sink failures are intentionally swallowed — we don't want a logger
    // bug to crash a backfill. Print to stderr so an operator can spot it.
    process.stderr.write(
      `[pino-db-transport] sink.insert failed: ${(err as Error).message}\n`,
    );
  }
}

/**
 * pino hook factory. Use:
 *   pino({ hooks: { logMethod: scriptErrorLogHook("backfill-foo") } })
 */
export function scriptErrorLogHook(scriptName: string) {
  const machine = hostname();
  return function logMethod(
    this: { level: number; levels: { values: Record<string, number> } },
    inputArgs: unknown[],
    method: (...args: unknown[]) => void,
    levelValue: number,
  ): void {
    // Always forward to the underlying writer first.
    method.apply(this, inputArgs);
    const levelName = PINO_LEVELS[levelValue];
    if (!levelName) return;
    if (!sink) return;
    const record = recordFromArgs(scriptName, levelName, machine, inputArgs);
    buffer.push(record);
    if (buffer.length >= BATCH_SIZE) void flushNow();
  };
}

function recordFromArgs(
  scriptName: string,
  level: "warn" | "error" | "fatal",
  machine: string,
  args: unknown[],
): ScriptErrorRecord {
  // pino positional: (obj?, msg?, ...interpolation)
  // Normalize both shapes.
  let context: Record<string, unknown> | null = null;
  let message = "";
  let stack: string | null = null;
  if (args.length === 1 && typeof args[0] === "string") {
    message = args[0];
  } else if (args.length >= 2 && typeof args[1] === "string") {
    context = (args[0] as Record<string, unknown>) ?? null;
    message = args[1];
  } else if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
    context = args[0] as Record<string, unknown>;
    message = (context.msg as string) ?? "";
  }
  if (context && context.err instanceof Error) {
    stack = (context.err as Error).stack ?? null;
  } else if (context && context.error instanceof Error) {
    stack = (context.error as Error).stack ?? null;
  }
  return {
    id: randomUUID(),
    scriptName,
    level,
    message,
    stack,
    context,
    machine,
    exitCode: null,
    createdAt: new Date(),
  };
}

/**
 * Direct record-push for callers (like withErrorCapture) that synthesize
 * an error from an uncaught exception rather than a logger call.
 */
export function pushScriptError(record: ScriptErrorRecord): void {
  buffer.push(record);
  if (buffer.length >= BATCH_SIZE) void flushNow();
}
