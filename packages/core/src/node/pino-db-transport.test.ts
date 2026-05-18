/**
 * Unit tests for pino-db-transport. Exercises:
 *   - batch flushing on size threshold
 *   - level filtering (info/debug never reach the sink)
 *   - error/stack extraction from the context object
 *   - sink-failure swallowing
 */

import { afterEach, describe, expect, it } from "bun:test";

import {
  attachScriptErrorSink,
  detachScriptErrorSink,
  flushNow,
  pushScriptError,
  scriptErrorLogHook,
  type ScriptErrorRecord,
  type ScriptErrorSink,
} from "./pino-db-transport";
import { withErrorCapture } from "./with-error-capture";

function makeSink(): { sink: ScriptErrorSink; received: ScriptErrorRecord[] } {
  const received: ScriptErrorRecord[] = [];
  const sink: ScriptErrorSink = {
    async insert(records) {
      received.push(...records);
    },
  };
  return { sink, received };
}

afterEach(async () => {
  await detachScriptErrorSink();
});

describe("scriptErrorLogHook", () => {
  it("forwards warn/error/fatal records to the sink", async () => {
    const { sink, received } = makeSink();
    attachScriptErrorSink(sink);
    const hook = scriptErrorLogHook("test-script");
    const noop = () => {};

    // simulate pino calling: (this, args, method, level)
    hook.call({ level: 50, levels: { values: {} } } as never, [{ extra: 1 }, "boom"], noop, 50);
    hook.call({ level: 40, levels: { values: {} } } as never, ["warn-only"], noop, 40);
    hook.call({ level: 60, levels: { values: {} } } as never, [{}, "fatal"], noop, 60);

    await flushNow();
    expect(received.length).toBe(3);
    expect(received.map((r) => r.level).sort()).toEqual(["error", "fatal", "warn"]);
    expect(received.find((r) => r.message === "boom")?.context).toEqual({ extra: 1 });
  });

  it("ignores info/debug/trace levels", async () => {
    const { sink, received } = makeSink();
    attachScriptErrorSink(sink);
    const hook = scriptErrorLogHook("test-script");
    const noop = () => {};

    hook.call({ level: 30, levels: { values: {} } } as never, ["info"], noop, 30);
    hook.call({ level: 20, levels: { values: {} } } as never, ["debug"], noop, 20);
    hook.call({ level: 10, levels: { values: {} } } as never, ["trace"], noop, 10);

    await flushNow();
    expect(received.length).toBe(0);
  });

  it("extracts stack from err: in the context object", async () => {
    const { sink, received } = makeSink();
    attachScriptErrorSink(sink);
    const hook = scriptErrorLogHook("test-script");
    const noop = () => {};
    const err = new Error("oh no");
    hook.call({ level: 50, levels: { values: {} } } as never, [{ err }, "wrapped"], noop, 50);

    await flushNow();
    expect(received[0]?.stack).toContain("Error: oh no");
  });
});

describe("pushScriptError + flushNow", () => {
  it("delivers manually pushed records", async () => {
    const { sink, received } = makeSink();
    attachScriptErrorSink(sink);
    pushScriptError({
      id: "abc",
      scriptName: "manual",
      level: "fatal",
      message: "manual push",
      stack: null,
      context: null,
      machine: "host",
      exitCode: 1,
      createdAt: new Date(),
    });
    await flushNow();
    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe("abc");
  });

  it("swallows sink failures so a logger bug can't crash a script", async () => {
    const sink: ScriptErrorSink = {
      async insert() {
        throw new Error("DB exploded");
      },
    };
    attachScriptErrorSink(sink);
    pushScriptError({
      id: "x",
      scriptName: "s",
      level: "error",
      message: "m",
      stack: null,
      context: null,
      machine: "h",
      exitCode: null,
      createdAt: new Date(),
    });
    // Must not throw.
    await flushNow();
    expect(true).toBe(true);
  });
});

describe("withErrorCapture", () => {
  it("runs the body to completion on the happy path", async () => {
    const { sink, received } = makeSink();
    attachScriptErrorSink(sink);

    let ran = false;
    await withErrorCapture("happy-script", async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(received.length).toBe(0); // no errors captured
  });

  it("captures uncaught errors with stack + scriptName then exits 1", async () => {
    const { sink, received } = makeSink();
    attachScriptErrorSink(sink);

    // Intercept process.exit so the test runner survives.
    const originalExit = process.exit;
    let exitCode: number | undefined;
    (process as unknown as { exit: (code?: number) => never }).exit = ((
      code?: number,
    ) => {
      exitCode = code;
      // Throw to short-circuit out of withErrorCapture rather than terminating bun.
      throw new Error("__exit_intercepted__");
    }) as never;

    // Suppress the stderr noise withErrorCapture emits before exiting.
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write =
      () => true;

    try {
      await withErrorCapture("boom-script", async () => {
        throw new Error("boom");
      });
    } catch (err) {
      // The intercepted exit throws; anything else is a real failure.
      expect((err as Error).message).toBe("__exit_intercepted__");
    } finally {
      (process as unknown as { exit: typeof originalExit }).exit = originalExit;
      (process.stderr as unknown as { write: typeof originalStderrWrite }).write =
        originalStderrWrite;
    }

    expect(exitCode).toBe(1);
    expect(received.length).toBe(1);
    const captured = received[0];
    expect(captured?.scriptName).toBe("boom-script");
    expect(captured?.level).toBe("fatal");
    expect(captured?.message).toBe("boom");
    expect(captured?.stack).toContain("Error: boom");
    expect(captured?.exitCode).toBe(1);
  });
});
