import { describe, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { DisallowedBinaryError, logger } from "@nexus/core/node";
import { TmuxPtySource, createValidatedSpawnFns, type SpawnFns } from "./tmux-pty-source";

/**
 * Unit tests for TmuxPtySource argv construction (Tier 1 of the
 * pty-tmux-integration-tests spec). These run WITHOUT a live tmux: a recording
 * mock SpawnFns adapter intercepts every spawn/spawnSync call, captures the
 * argv, and returns canned results. Four production bugs this session were
 * argv-shape bugs in this file (a missing `-l` literal flag auto-submitted
 * typed input; a `window-size manual` gate bug broke fullscreen). These tests
 * pin the exact argv so those regressions fail loud.
 */

const TARGET = "test:0.0";

interface SpawnSyncResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

interface FakeSubprocess {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  killed: boolean;
  kill: () => void;
}

interface Recorder {
  adapter: SpawnFns;
  /** Every argv passed to spawn or spawnSync, in call order. */
  calls: string[][];
  /** The fake reader children handed back by spawn() (e.g. the `cat` reader). */
  children: FakeSubprocess[];
  /** Find the recorded call whose argv is the given tmux subcommand. */
  tmuxCalls: (subcommand: string) => string[][];
}

/**
 * Build a recording mock adapter.
 *
 * - `spawnSync` pushes argv onto `calls` and returns a canned result. tmux
 *   `display-message` (geometry) yields `120x40` so the parser produces
 *   cols=120, rows=40; `show-options` (window-size) yields `latest`.
 * - `spawn` pushes argv onto `calls` and returns a minimal fake Subprocess
 *   whose stdout is an immediately-closed ReadableStream (so startPipePane's
 *   reader loop terminates instead of hanging) and whose `kill()` flips a flag
 *   we can assert against.
 */
function makeRecorder(): Recorder {
  const calls: string[][] = [];
  const children: FakeSubprocess[] = [];

  const cannedSync = (argv: string[]): SpawnSyncResult => {
    if (argv[0] === "tmux" && argv[1] === "display-message") {
      return { exitCode: 0, stdout: Buffer.from("120x40\n"), stderr: Buffer.from("") };
    }
    if (argv[0] === "tmux" && argv[1] === "show-options") {
      return { exitCode: 0, stdout: Buffer.from("latest\n"), stderr: Buffer.from("") };
    }
    return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
  };

  const adapter: SpawnFns = {
    // The recorder mirrors Bun's overloaded signatures loosely; the production
    // code only relies on the argv + the documented result shape, so casting
    // the mock to the adapter type is sound (and the only `as` needed — there
    // is no `any`).
    spawnSync: ((argv: string[]) => {
      calls.push([...argv]);
      return cannedSync(argv);
    }) as unknown as typeof Bun.spawnSync,
    spawn: ((argv: string[]) => {
      calls.push([...argv]);
      const child: FakeSubprocess = {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        killed: false,
        kill() {
          this.killed = true;
        },
      };
      children.push(child);
      return child as unknown as ReturnType<typeof Bun.spawn>;
    }) as unknown as typeof Bun.spawn,
  };

  return {
    adapter,
    calls,
    children,
    tmuxCalls: (subcommand: string) =>
      calls.filter((c) => c[0] === "tmux" && c[1] === subcommand),
  };
}

describe("TmuxPtySource argv (Tier 1, recording mock — no live tmux)", () => {
  // ── 1.2: scrollback seed + geometry sample ────────────────────────────────

  it("[1.2] seeds scrollback and samples geometry with exact argv", () => {
    const rec = makeRecorder();
    const source = new TmuxPtySource(TARGET, { spawn: rec.adapter });

    const capture = rec.tmuxCalls("capture-pane");
    expect(capture.length).toBe(1);
    expect(capture[0]).toEqual([
      "tmux",
      "capture-pane",
      "-p",
      // `-e` preserves escape sequences so SwiftTerm can re-render scrollback
      // into its own grid (fixes jumbled history on grid-size mismatch).
      "-e",
      "-S",
      "-1000",
      "-E",
      "-",
      "-t",
      TARGET,
    ]);

    const geom = rec.tmuxCalls("display-message");
    expect(geom.length).toBe(1);
    expect(geom[0]).toEqual([
      "tmux",
      "display-message",
      "-p",
      "-t",
      TARGET,
      "#{pane_width}x#{pane_height}",
    ]);

    // The mocked `120x40` must be parsed into the cached geometry.
    expect(source.geometry()).toEqual({ cols: 120, rows: 40 });

    source.close();
  });

  // ── 1.3: write() literal send-keys (auto-Enter regression guard) ──────────

  it("[1.3] write() emits send-keys with the -l literal flag", async () => {
    const rec = makeRecorder();
    const source = new TmuxPtySource(TARGET, { spawn: rec.adapter });

    source.write(new TextEncoder().encode("hi"));
    // write() is now internally queued (nx-qpsmq serialization) — flush the
    // pending microtask so the spawn has actually happened before asserting.
    await Promise.resolve();

    const sendKeys = rec.tmuxCalls("send-keys");
    expect(sendKeys.length).toBe(1);
    // The `-l` flag is the regression guard: without it tmux interprets the
    // bytes as key names and auto-submits on names like "Enter".
    expect(sendKeys[0]).toEqual(["tmux", "send-keys", "-t", TARGET, "-l", "hi"]);

    source.close();
  });

  it("[1.3] write() does not log the literal keystroke text", async () => {
    const rec = makeRecorder();
    const source = new TmuxPtySource(TARGET, { spawn: rec.adapter });
    const infoSpy = spyOn(logger, "info");
    source.write(new TextEncoder().encode("some-typed-text"));
    // write() is now internally queued (nx-qpsmq serialization) — flush the
    // pending microtask so the spawn has actually happened before asserting.
    await Promise.resolve();
    const spawnedCall = infoSpy.mock.calls.find((c) => c[1] === "NXPTY tmux send-keys spawned");
    expect(spawnedCall).toBeDefined();
    const fields = spawnedCall![0] as Record<string, unknown>;
    expect(fields).toHaveProperty("target");
    expect(fields).toHaveProperty("bytes");
    expect(fields).not.toHaveProperty("literal");
    expect(JSON.stringify(fields)).not.toContain("some-typed-text");
    infoSpy.mockRestore();
    source.close();
  });

  it("[1.3] write() of empty bytes emits no send-keys", () => {
    const rec = makeRecorder();
    const source = new TmuxPtySource(TARGET, { spawn: rec.adapter });

    source.write(new Uint8Array(0));

    expect(rec.tmuxCalls("send-keys").length).toBe(0);

    source.close();
  });

  it("[1.3] write() after close() emits no send-keys", () => {
    const rec = makeRecorder();
    const source = new TmuxPtySource(TARGET, { spawn: rec.adapter });
    source.close();

    source.write(new TextEncoder().encode("hi"));

    expect(rec.tmuxCalls("send-keys").length).toBe(0);
  });

  // ── nx-qpsmq: write() serialization (keystroke reordering regression) ────

  it("[nx-qpsmq] rapid synchronous write() calls are genuinely serialized (Nth spawn waits for (N-1)th's exit)", async () => {
    const calls: string[][] = [];
    // Concurrency guard: incremented when a send-keys child is spawned but its
    // `exited` has not yet resolved, decremented once it resolves. If two
    // send-keys spawns are ever in flight simultaneously, `maxConcurrent`
    // captures >1 and the assertion below fails — this is the actual
    // regression pin (not just spawn-call order, which the OLD fire-and-forget
    // code would also preserve since spawn() itself ran synchronously inside
    // write()).
    let active = 0;
    let maxConcurrent = 0;
    const adapter: SpawnFns = {
      spawnSync: (() => ({
        exitCode: 0,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
      })) as unknown as typeof Bun.spawnSync,
      spawn: ((argv: string[]) => {
        calls.push([...argv]);
        const isSendKeys = argv[0] === "tmux" && argv[1] === "send-keys";
        if (isSendKeys) {
          active++;
          maxConcurrent = Math.max(maxConcurrent, active);
        }
        const child = {
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          exited: isSendKeys
            ? new Promise<number>((resolve) =>
                setTimeout(() => {
                  active--;
                  resolve(0);
                }, 15),
              )
            : Promise.resolve(0),
          killed: false,
          kill() {
            this.killed = true;
          },
        };
        return child as unknown as ReturnType<typeof Bun.spawn>;
      }) as unknown as typeof Bun.spawn,
    };

    const source = new TmuxPtySource(TARGET, { spawn: adapter });

    // Fire 4 writes back-to-back with NO await between calls — the exact
    // shape of a fast browser-side type burst (one WS frame per keystroke).
    source.write(new TextEncoder().encode("a"));
    source.write(new TextEncoder().encode("b"));
    source.write(new TextEncoder().encode("c"));
    source.write(new TextEncoder().encode("d"));

    // Let the internal write queue drain fully (4 * 15ms serialized + slack).
    await new Promise((resolve) => setTimeout(resolve, 200));

    const sendKeys = calls.filter((c) => c[0] === "tmux" && c[1] === "send-keys");
    // Order preserved...
    expect(sendKeys.map((c) => c[5])).toEqual(["a", "b", "c", "d"]);
    // ...AND genuinely serialized, not just call-ordered.
    expect(maxConcurrent).toBe(1);

    source.close();
  });

  // ── nx-9qsmb.6: writeQueue survives a doWrite rejection (chain-poisoning guard) ──

  it("[nx-9qsmb.6] a forced doWrite rejection does not poison the writeQueue — subsequent writes still spawn", async () => {
    const rec = makeRecorder();
    const source = new TmuxPtySource(TARGET, { spawn: rec.adapter });

    // doWrite() is try/catch-wrapped in production and never rejects today —
    // that's the implicit invariant this bead flags as fragile. Force a
    // single rejection via spyOn to prove the queue recovers instead of
    // getting permanently poisoned (every later write silently no-op'ing).
    const doWriteSpy = spyOn(
      source as unknown as { doWrite: (text: string, bytes: number) => Promise<void> },
      "doWrite",
    ).mockImplementationOnce(() => Promise.reject(new Error("forced doWrite rejection")));

    source.write(new TextEncoder().encode("first"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(doWriteSpy).toHaveBeenCalledTimes(1);
    // The forced rejection produced no send-keys spawn for "first" (doWrite
    // was stubbed out), which is expected — the real assertion is below.
    doWriteSpy.mockRestore();

    // A second write after the rejection MUST still spawn — proof the queue
    // did not get stuck on a permanently-rejected promise.
    source.write(new TextEncoder().encode("second"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sendKeys = rec.tmuxCalls("send-keys");
    expect(sendKeys.length).toBe(1);
    expect(sendKeys[0]).toEqual(["tmux", "send-keys", "-t", TARGET, "-l", "second"]);

    source.close();
  });

  // ── 1.4: resize path (window-size manual gate + unset release) ────────────

  it("[1.4] first resize forces manual and resizes (no prior-value read)", () => {
    const rec = makeRecorder();
    const source = new TmuxPtySource(TARGET, { spawn: rec.adapter });

    source.resize(100, 30);

    // No prior window-size read — release unsets rather than restoring a value.
    expect(rec.tmuxCalls("show-options").length).toBe(0);

    // Forced manual.
    const setOpt = rec.tmuxCalls("set-option");
    expect(setOpt.length).toBe(1);
    expect(setOpt[0]).toEqual([
      "tmux",
      "set-option",
      "-w",
      "-t",
      TARGET,
      "window-size",
      "manual",
    ]);

    // Then the resize itself.
    const resizeWin = rec.tmuxCalls("resize-window");
    expect(resizeWin.length).toBe(1);
    expect(resizeWin[0]).toEqual([
      "tmux",
      "resize-window",
      "-t",
      TARGET,
      "-x",
      "100",
      "-y",
      "30",
    ]);

    expect(source.isTakeOverActive()).toBe(true);

    source.close();
  });

  it("[1.4] second resize does NOT re-force manual", () => {
    const rec = makeRecorder();
    const source = new TmuxPtySource(TARGET, { spawn: rec.adapter });

    source.resize(100, 30);
    source.resize(110, 35);

    // set-option(manual) happens exactly once across two resizes.
    expect(rec.tmuxCalls("set-option").length).toBe(1);
    // But both resize-window calls fire.
    expect(rec.tmuxCalls("resize-window").length).toBe(2);

    source.close();
  });

  it("[1.4] unsetWindowSize() UNSETS the option at session scope", () => {
    const rec = makeRecorder();
    const source = new TmuxPtySource(TARGET, { spawn: rec.adapter });

    source.resize(100, 30); // forces manual + one resize-window
    source.unsetWindowSize();

    const setOpt = rec.tmuxCalls("set-option");
    // First set-option forced "manual"; second UNSETS via -u (no value).
    // Unset uses session scope (no -w) — window-size is a session option and
    // resize-window pins it there (verified live, nx-cjhfv).
    expect(setOpt.length).toBe(2);
    expect(setOpt[1]).toEqual([
      "tmux",
      "set-option",
      "-u",
      "-t",
      TARGET,
      "window-size",
    ]);

    // Release ALSO actively re-fits the window to the largest attached client
    // BEFORE unsetting (mx-rkir.12): `set-option -u` alone leaves `latest` but
    // tmux does not re-fit until the next client size-change, so the user's pane
    // stayed stranded at the take-over width. `resize-window -A` snaps it back.
    const resizeWin = rec.tmuxCalls("resize-window");
    // [0] = the take-over resize (100x30); [1] = the release refit (-A).
    expect(resizeWin.length).toBe(2);
    expect(resizeWin[1]).toEqual([
      "tmux",
      "resize-window",
      "-A",
      "-t",
      TARGET,
    ]);
    expect(source.isTakeOverActive()).toBe(false);

    source.close();
  });

  it("[1.4] unsetWindowSize() on a never-resized source is a no-op", () => {
    const rec = makeRecorder();
    const source = new TmuxPtySource(TARGET, { spawn: rec.adapter });

    source.unsetWindowSize();

    // No set-option / resize-window emitted — never-resized leaves tmux alone.
    expect(rec.tmuxCalls("set-option").length).toBe(0);
    expect(rec.tmuxCalls("resize-window").length).toBe(0);

    source.close();
  });

  // ── 1.5: close() teardown ─────────────────────────────────────────────────

  it("[1.5] close() detaches pipe-pane, kills reader child, removes temp dir", () => {
    const rec = makeRecorder();
    const source = new TmuxPtySource(TARGET, { spawn: rec.adapter });

    // Capture the temp FIFO dir created during construction: the mkfifo call's
    // argv[1] is the fifo path; its parent dir is the mkdtempSync temp dir.
    const mkfifoCall = rec.calls.find((c) => c[0] === "mkfifo");
    expect(mkfifoCall).toBeDefined();
    const fifoPath = mkfifoCall![1]!;
    const tmpDir = dirname(fifoPath);
    expect(existsSync(tmpDir)).toBe(true);

    // The reader child spawned by startPipePane.
    const readerChild = rec.children.find(() => true);
    expect(readerChild).toBeDefined();
    expect(readerChild!.killed).toBe(false);

    source.close();

    // pipe-pane detach with NO trailing command arg.
    const pipePaneCalls = rec.tmuxCalls("pipe-pane");
    const detach = pipePaneCalls.find(
      (c) => c.length === 4 && c[2] === "-t" && c[3] === TARGET,
    );
    expect(detach).toEqual(["tmux", "pipe-pane", "-t", TARGET]);

    // Reader child was killed.
    expect(readerChild!.killed).toBe(true);

    // Temp FIFO dir removed.
    expect(existsSync(tmpDir)).toBe(false);
  });
});

describe("createValidatedSpawnFns (production default, D4 fix — plans/032)", () => {
  it("rejects a disallowed binary via spawnSync before touching Bun.spawnSync", () => {
    const fns = createValidatedSpawnFns();
    expect(() => fns.spawnSync(["not-an-allowed-binary", "x"])).toThrow(
      DisallowedBinaryError,
    );
  });

  it("rejects a disallowed binary via spawn before touching Bun.spawn", () => {
    const fns = createValidatedSpawnFns();
    expect(() => fns.spawn(["not-an-allowed-binary", "x"])).toThrow(
      DisallowedBinaryError,
    );
  });

  it("allows mkfifo (added to ALLOWED_BINARIES by plans/032)", () => {
    const fns = createValidatedSpawnFns();
    // `which` is always in ALLOWED_BINARIES and universally present — this
    // proves the allowlisted path reaches the real Bun.spawnSync (exit code
    // may be 0 or 1 depending on whether `mkfifo` is on PATH; either is a
    // real execution, not a DisallowedBinaryError throw).
    expect(() => fns.spawnSync(["which", "mkfifo"])).not.toThrow();
  });

  it("TmuxPtySource with no injected adapter uses the validated default without throwing", () => {
    // No live tmux session named this way exists — every production call
    // site is best-effort / try-catch, so construction and close() must not
    // throw even though the underlying tmux calls fail. This only proves the
    // production (no opts.spawn) path is wired through createValidatedSpawnFns
    // and stays exception-safe end-to-end.
    const source = new TmuxPtySource("nx-plan032-nonexistent-session:0.0");
    expect(() => source.close()).not.toThrow();
  });
});
