import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { TmuxPtySource, type SpawnFns } from "./tmux-pty-source";

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

  it("[1.3] write() emits send-keys with the -l literal flag", () => {
    const rec = makeRecorder();
    const source = new TmuxPtySource(TARGET, { spawn: rec.adapter });

    source.write(new TextEncoder().encode("hi"));

    const sendKeys = rec.tmuxCalls("send-keys");
    expect(sendKeys.length).toBe(1);
    // The `-l` flag is the regression guard: without it tmux interprets the
    // bytes as key names and auto-submits on names like "Enter".
    expect(sendKeys[0]).toEqual(["tmux", "send-keys", "-t", TARGET, "-l", "hi"]);

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
