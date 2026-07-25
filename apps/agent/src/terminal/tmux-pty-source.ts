/**
 * TmuxPtySource — a PtySource backed by an existing tmux pane.
 *
 * Used by the lazy-attach path on `/sessions/:id/stream` WebSocket upgrade:
 * the process-watcher discovers tmux-resident `claude` sessions and inserts
 * rows into the `sessions` table with `tmux_session` + `tmux_target`
 * populated, but the agent never calls `streamManager.attach(...)` for them.
 * Without an attached PTY, the WS upgrade returns 404 ("session not found").
 *
 * Lifecycle:
 *   - Construct: spawn `tmux pipe-pane -O -t <target> 'cat'` to stream output.
 *   - getScrollback(): run `tmux capture-pane -p -S -1000 -E - -t <target>`
 *     ONCE at attach to seed the ring buffer with recent history.
 *   - write(): run `tmux send-keys -t <target> <text>` (interact mode).
 *   - close(): kill the pipe-pane child + run `tmux pipe-pane -t <target>`
 *     (no command) to detach the pipe on the tmux side.
 *
 * Geometry: `geometry()` returns the last-observed pane size, acquired via
 * `tmux display-message -p -t <target> '#{pane_width}x#{pane_height}'`. The
 * value is read once at construction and re-sampled cheaply on the pipe-pane
 * read loop so a `geometry` control frame can be pushed to viewers when the
 * real pane resizes. Viewers in lock mode size their emulator grid to this so
 * cursor-positioning escapes (CUP) land in the right cells (fixes the jumble).
 *
 * Resize (take-over mode): `resize(cols, rows)` runs `tmux resize-window` and
 * forces `window-size manual` for the take-over duration so the requested size
 * sticks. On last-viewer detach, `unsetWindowSize()` UNSETS the option (tmux
 * `set-option -u`) so tmux re-fits the window to whatever client is attached,
 * rather than restoring a recorded prior value/geometry (nx-cjhfv).
 *
 * Spec: nx-omso0 — fix(agent): lazy-attach tmux PtySource on
 *   /sessions/<id>/stream upgrade.
 * Spec: pty-adaptive-geometry-fullscreen (nx-3bai2) — geometry report +
 *   viewer-driven resize + auto-restore.
 */

import { assertAllowedBinary, logger } from "@nexus/core/node";
import type { PtySource } from "./pty-source";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_SCROLLBACK_CAPACITY = 10_000;
const SCROLLBACK_LINES = 1000;
const TMUX_TARGET_RE = /^[A-Za-z0-9_.:%@/-]+$/;
const DEFAULT_GEOMETRY = { cols: 80, rows: 24 } as const;

/**
 * INSTRUMENTATION SPIKE (nx-f1l69) — attach-handshake / geometry race probe.
 *
 * Heuristic: does a string END cleanly on an escape-sequence boundary, or is
 * it cut mid-CSI/OSC? A clean tail is the LAST byte not being inside an
 * unterminated `ESC` / `ESC[` (CSI) / `ESC]` (OSC) sequence. Cheap scan from
 * the end — we only need the trailing context, not a full parse.
 *
 * Returns true when the buffer is safe to hand to the emulator at this
 * boundary (cause-(b) discriminator: a `false` here means the scrollback seed
 * splits a sequence, so SwiftTerm sees a mid-escape boundary when live
 * pipe-pane bytes take over).
 */
function endsOnEscapeBoundary(s: string): boolean {
  if (s.length === 0) return true;
  // Walk backwards to the last ESC (0x1b). If none, no pending sequence.
  const lastEsc = s.lastIndexOf("\x1b");
  if (lastEsc === -1) return true;
  const tail = s.slice(lastEsc);
  // Bare ESC at the very end — pending, not clean.
  if (tail === "\x1b") return false;
  const kind = tail[1];
  if (kind === "[") {
    // CSI: ESC [ params... final-byte (0x40..0x7e). Clean iff a final byte
    // appears after the introducer.
    return /\x1b\[[0-9;?]*[@-~]/.test(tail);
  }
  if (kind === "]") {
    // OSC: ESC ] ... terminated by BEL (0x07) or ST (ESC \). Clean iff a
    // terminator appears.
    return /\x07/.test(tail) || /\x1b\\/.test(tail);
  }
  // Other ESC-prefixed forms (e.g. ESC ( charset, ESC =) are 2-3 bytes; if we
  // have at least the second byte we treat the short forms as complete. The
  // only ambiguous case is a trailing lone ESC, handled above.
  return tail.length >= 2;
}
/**
 * Minimum interval between geometry re-samples on the pipe-pane read loop.
 * Each sample shells out to `tmux display-message`, so we throttle to avoid a
 * spawn per output burst while still detecting real pane resizes within ~1s.
 */
const GEOMETRY_SAMPLE_INTERVAL_MS = 1000;

class RingBuffer {
  private buf: string[];
  private head = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.buf = new Array<string>(capacity);
  }

  push(line: string): void {
    this.buf[this.head] = line;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  toArray(): string[] {
    if (this.count < this.capacity) {
      return this.buf.slice(0, this.count);
    }
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }
}

/**
 * Injectable spawn adapter. The default binds the real `Bun.spawn` /
 * `Bun.spawnSync`; tests inject a recording mock to assert exact tmux argv
 * without spawning a live tmux. The shapes match Bun's signatures exactly so
 * production behavior is byte-for-byte identical to calling `Bun.spawn*`
 * directly.
 */
export interface SpawnFns {
  spawn: typeof Bun.spawn;
  spawnSync: typeof Bun.spawnSync;
}

/**
 * Production spawn adapter — validates the binary against safeSpawn's
 * ALLOWED_BINARIES (packages/core/src/safe-spawn.ts) before delegating to
 * the real Bun.spawn/Bun.spawnSync.
 *
 * This is NOT a call to safeSpawn() itself: safeSpawn is fully async
 * (SafeSpawnHandle.exitCode is a Promise), but 9 of this file's 11 spawn
 * call sites run synchronously (the constructor, resize(), unsetWindowSize(),
 * setWindowSizeOption(), close()) and there is no sync safeSpawn equivalent.
 * Reusing assertAllowedBinary here gives every call site the same allowlist
 * guarantee safeSpawn provides, at the single choke point where the default
 * adapter is constructed, without an architecture change to make
 * construction/resize/close async (see plans/032 Design decision).
 *
 * Arg-CONTENT validation (safeSpawn's other guarantee, isSafeArg) is
 * deliberately NOT applied here: doWrite()'s `tmux send-keys -l <text>` call
 * sends arbitrary client keystrokes that legitimately contain shell
 * metacharacters. Every call in this file is an argv-vector spawn (no shell
 * on our side), so arg content can never cause OS-level injection regardless
 * of characters; the tmux TARGET is validated separately by
 * isValidTmuxTarget() before it reaches this class's constructor.
 */
export function createValidatedSpawnFns(): SpawnFns {
  function checkBinary(argv: readonly string[]): void {
    const binary = argv[0];
    if (binary !== undefined) assertAllowedBinary(binary);
  }
  return {
    spawn: ((argv: string[], opts?: unknown) => {
      checkBinary(argv);
      return Bun.spawn(argv, opts as Parameters<typeof Bun.spawn>[1]);
    }) as typeof Bun.spawn,
    spawnSync: ((argv: string[], opts?: unknown) => {
      checkBinary(argv);
      return Bun.spawnSync(argv, opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync,
  };
}

export interface TmuxPtySourceOptions {
  /** Scrollback buffer capacity (default 10 000). */
  scrollbackCapacity?: number;
  /**
   * Injectable spawn adapter (default: real Bun functions). Tests pass a
   * recording mock; production omits this so the real binaries run.
   */
  spawn?: SpawnFns;
}

/**
 * Validate a tmux target string. tmux targets look like
 * `session:window.pane`, `session:window`, or just `session`. Restricting
 * to `[A-Za-z0-9_.:%@/-]` covers every legal form and rejects shell
 * metacharacters defense-in-depth (even though safeSpawn already does).
 */
export function isValidTmuxTarget(target: string): boolean {
  return target.length > 0 && target.length <= 256 && TMUX_TARGET_RE.test(target);
}

/**
 * A PtySource that streams output from a tmux pane via `tmux pipe-pane`.
 * Constructor MUST receive a target validated upstream (see
 * `isValidTmuxTarget`). Failing that, the spawn will reject with a
 * DisallowedBinaryError or tmux non-zero exit; close() is safe in either
 * case.
 */
export class TmuxPtySource implements PtySource {
  private scrollback: RingBuffer;
  private listeners = new Set<(data: Uint8Array) => void>();
  private closed = false;
  private pipeChild: Subprocess<"ignore", "pipe", "ignore"> | null = null;
  /**
   * Temp directory holding the FIFO that tmux's pipe-pane shell command
   * writes into. We delete the directory in close() so disk usage is bounded
   * by the number of concurrent attached sessions.
   */
  private tmpDir: string | null = null;
  private fifoPath: string | null = null;

  /** Last-observed pane geometry, re-sampled on the read loop. */
  private _geometry: { cols: number; rows: number } = { ...DEFAULT_GEOMETRY };
  /** Wall-clock of the last geometry sample (throttle gate). */
  private lastGeometrySampleAt = 0;
  /**
   * INSTRUMENTATION SPIKE (nx-f1l69) — cause (a) probe. Tracks whether the
   * first geometry sample (at construction) has run and whether the first
   * data byte has been emitted to listeners, so we can log the geometry-vs-
   * first-data ORDERING. If first data is emitted before the construction-time
   * geometry sample lands (or the geometry frame is still the DEFAULT 80x24),
   * cursor-positioning escapes land in a wrong-sized grid.
   */
  private didEmitFirstData = false;
  private geometrySampleCount = 0;
  /** Subscribers notified when the observed pane geometry changes. */
  private geometryListeners = new Set<(geom: { cols: number; rows: number }) => void>();
  /**
   * Whether `resize()` has forced `window-size manual` for this target. `false`
   * means take-over has not mutated the option, so the release path must NOT
   * touch it (a never-resized / read-only viewer disconnect leaves tmux alone).
   */
  private takeOverActive = false;

  /**
   * Spawn adapter — defaults to the real Bun functions. Stored as the FIRST
   * constructor statement because `seedScrollback`/`sampleGeometry`/
   * `startPipePane` run inside the constructor and must see the adapter.
   */
  private readonly spawn: SpawnFns;

  constructor(
    private readonly target: string,
    opts: TmuxPtySourceOptions = {},
  ) {
    this.spawn = opts.spawn ?? createValidatedSpawnFns();
    const capacity = opts.scrollbackCapacity ?? DEFAULT_SCROLLBACK_CAPACITY;
    this.scrollback = new RingBuffer(capacity);
    this.seedScrollback();
    // Acquire pane geometry once at attach so the first geometry frame is
    // accurate. Best-effort — falls back to DEFAULT_GEOMETRY on failure.
    this.sampleGeometry();
    this.startPipePane();
  }

  /**
   * Read recent pane contents synchronously at attach so viewers see
   * context immediately. Best-effort — tmux missing or pane gone yields
   * an empty scrollback (the stream will still work).
   */
  private seedScrollback(): void {
    try {
      const proc = this.spawn.spawnSync(
        [
          "tmux",
          "capture-pane",
          "-p",
          // `-e` preserves escape sequences in captured scrollback. Without it,
          // tmux returns text pre-wrapped at the ORIGINAL pane's grid width with
          // escapes stripped; when SwiftTerm re-renders into a differently sized
          // grid the history looks jumbled. With `-e`, SwiftTerm replays the real
          // escapes into its own grid so wrapping stays correct on resize.
          "-e",
          "-S",
          `-${SCROLLBACK_LINES}`,
          "-E",
          "-",
          "-t",
          this.target,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (proc.exitCode !== 0) {
        logger.debug(
          { target: this.target, exitCode: proc.exitCode },
          "tmux capture-pane non-zero — empty scrollback",
        );
        return;
      }
      const text = proc.stdout.toString();
      // INSTRUMENTATION SPIKE (nx-f1l69) — cause (b): the capture-pane `-e`
      // seed is line-split here (and dropped empties), then re-joined with
      // "\n" by stream-manager.addViewer before being handed to SwiftTerm as
      // BINARY. If the raw capture does NOT end on an escape boundary, the
      // seed can deliver SwiftTerm a mid-escape-sequence boundary right where
      // the live pipe-pane stream takes over. `endsClean=false` is the
      // smoking gun for cause (b).
      logger.info(
        {
          target: this.target,
          event: "scrollbackSeed",
          bytes: Buffer.byteLength(text, "utf8"),
          lines: text.split("\n").length,
          endsClean: endsOnEscapeBoundary(text),
          ts: Date.now(),
        },
        "nx-f1l69 scrollbackSeed",
      );
      for (const line of text.split("\n")) {
        if (line.length > 0) this.scrollback.push(line);
      }
    } catch (err) {
      logger.debug(
        { target: this.target, error: err instanceof Error ? err.message : String(err) },
        "tmux capture-pane threw — empty scrollback",
      );
    }
  }

  /**
   * Sample the pane geometry via
   * `tmux display-message -p -t <target> '#{pane_width}x#{pane_height}'`.
   * Updates the cached value and, if it changed, notifies geometry listeners
   * (so server-websocket can push a `geometry` control frame). Best-effort:
   * on any failure the cached value is left untouched.
   *
   * Returns the cached geometry after the sample.
   */
  private sampleGeometry(): { cols: number; rows: number } {
    this.lastGeometrySampleAt = Date.now();
    try {
      const proc = this.spawn.spawnSync(
        [
          "tmux",
          "display-message",
          "-p",
          "-t",
          this.target,
          "#{pane_width}x#{pane_height}",
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      if (proc.exitCode !== 0) return this._geometry;
      const out = proc.stdout.toString().trim();
      const m = out.match(/^(\d+)x(\d+)$/);
      if (!m) return this._geometry;
      const cols = Number(m[1]);
      const rows = Number(m[2]);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
        return this._geometry;
      }
      if (cols !== this._geometry.cols || rows !== this._geometry.rows) {
        this._geometry = { cols, rows };
        for (const cb of this.geometryListeners) {
          try {
            cb(this._geometry);
          } catch {
            // subscriber threw — ignore
          }
        }
      }
      // INSTRUMENTATION SPIKE (nx-f1l69) — cause (a): pane dims at attach
      // (sampleNo=1, from the constructor) and on each resample. `firstData`
      // is the ordering signal — if `didEmitFirstData=true` when sampleNo=1
      // fires, live bytes raced ahead of the initial geometry frame.
      this.geometrySampleCount += 1;
      logger.info(
        {
          target: this.target,
          event: "paneDims",
          sampleNo: this.geometrySampleCount,
          cols,
          rows,
          firstDataAlreadyEmitted: this.didEmitFirstData,
          ts: Date.now(),
        },
        "nx-f1l69 paneDims",
      );
    } catch (err) {
      logger.debug(
        { target: this.target, error: err instanceof Error ? err.message : String(err) },
        "tmux display-message (geometry) threw — keeping cached geometry",
      );
    }
    return this._geometry;
  }

  /**
   * Set up streaming via a temp FIFO. tmux's `pipe-pane` runs its shell
   * command inside the tmux SERVER process — its stdin is the pane output,
   * but its stdout/stderr default to /dev/null (tmux server context).
   * That means a naive `cat` cannot deliver bytes back to our agent process.
   *
   * Workaround: create a FIFO in a temp dir, tell tmux to redirect pane
   * output into the FIFO (`cat >$FIFO`), then spawn our own `cat $FIFO`
   * locally whose stdout IS attached to a Bun.spawn pipe we can read.
   *
   * Sequence is important: the FIFO must exist before pipe-pane is set up,
   * and our reader must open the FIFO so the writer side does not block on
   * an unread pipe.
   */
  private startPipePane(): void {
    try {
      this.tmpDir = mkdtempSync(join(tmpdir(), "nexus-tmux-pipe-"));
      this.fifoPath = join(this.tmpDir, "pipe");
      const mkfifo = this.spawn.spawnSync(["mkfifo", this.fifoPath], {
        stdout: "ignore",
        stderr: "pipe",
      });
      if (mkfifo.exitCode !== 0) {
        logger.warn(
          { target: this.target, exitCode: mkfifo.exitCode },
          "mkfifo failed — tmux stream unavailable",
        );
        return;
      }
      // Spawn the LOCAL reader first so the FIFO has a reader when tmux
      // opens the writer side. `cat` blocks on EOF — that's fine, close()
      // tears down the pipe-pane and kills this child.
      const reader = this.spawn.spawn(["cat", this.fifoPath], {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      });
      this.pipeChild = reader;
      void this.consumeStdout(reader.stdout);
      void reader.exited.then(() => {
        if (!this.closed) {
          logger.debug({ target: this.target }, "tmux pipe-pane reader exited early");
        }
      });
      // Now tell tmux to start writing pane output into the FIFO. Use
      // `cat >FIFO` so the tmux server's child shell writes through the
      // pipe. `-O` keeps the pipe open if pipe-pane is called again.
      const setup = this.spawn.spawnSync(
        ["tmux", "pipe-pane", "-O", "-t", this.target, `cat >${this.fifoPath}`],
        { stdout: "ignore", stderr: "pipe" },
      );
      if (setup.exitCode !== 0) {
        const err = setup.stderr.toString().trim();
        logger.warn(
          { target: this.target, exitCode: setup.exitCode, err },
          "tmux pipe-pane setup non-zero — stream may be empty",
        );
      }
    } catch (err) {
      logger.warn(
        { target: this.target, error: err instanceof Error ? err.message : String(err) },
        "failed to set up tmux pipe-pane FIFO",
      );
    }
  }

  private async consumeStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) return;
        if (!value || value.byteLength === 0) continue;
        // Re-sample pane geometry on output activity (throttled). A real user
        // resizing the pane (or tmux's own reflow) changes the dims; detecting
        // it here lets us push a fresh geometry frame to viewers so their grid
        // stays aligned. Cheap: gated by GEOMETRY_SAMPLE_INTERVAL_MS.
        if (Date.now() - this.lastGeometrySampleAt >= GEOMETRY_SAMPLE_INTERVAL_MS) {
          this.sampleGeometry();
        }
        // Record raw bytes' textual form in scrollback (line-split).
        try {
          const text = new TextDecoder("utf-8", { fatal: false }).decode(value);
          for (const line of text.split("\n")) {
            if (line.length > 0) this.scrollback.push(line);
          }
        } catch {
          // ignore decode errors — still forward bytes to listeners
        }
        // INSTRUMENTATION SPIKE (nx-f1l69) — cause (a): timestamp + dims at the
        // moment the FIRST live pipe-pane bytes are emitted to listeners. Pair
        // this `ts` against the `paneDims` sampleNo=1 `ts` and `scrollbackSeed`
        // `ts` to reconstruct the geometry-vs-data ordering: if firstData here
        // precedes the geometry frame reaching the viewer, escapes land in a
        // wrong-sized grid.
        if (!this.didEmitFirstData) {
          this.didEmitFirstData = true;
          logger.info(
            {
              target: this.target,
              event: "firstData",
              bytes: value.byteLength,
              geometryCols: this._geometry.cols,
              geometryRows: this._geometry.rows,
              geometrySampled: this.geometrySampleCount > 0,
              ts: Date.now(),
            },
            "nx-f1l69 firstData",
          );
        }
        for (const cb of this.listeners) {
          try {
            cb(value);
          } catch {
            // subscriber threw — ignore
          }
        }
      }
    } catch (err) {
      logger.debug(
        { target: this.target, error: err instanceof Error ? err.message : String(err) },
        "tmux pipe-pane stdout reader threw",
      );
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  onData(callback: (data: Uint8Array) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  getScrollback(): string[] {
    return this.scrollback.toArray();
  }

  /**
   * Serializes `send-keys` invocations so concurrent fast keystrokes cannot
   * race each other as independent subprocesses (nx-qpsmq). Each queued write
   * waits for the previous `doWrite` to fully resolve (spawn + process exit)
   * before starting, while `write()` itself stays synchronous/fire-and-forget
   * for the caller.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * Write bytes into the tmux pane via `send-keys`. Best-effort,
   * fire-and-forget — failures are logged at debug level only. Internally
   * serialized through `writeQueue` (see nx-qpsmq) so keystroke order is
   * preserved even when `write()` is called rapidly without awaiting.
   */
  write(data: Uint8Array): void {
    if (this.closed) return;
    const text = new TextDecoder().decode(data);
    if (text.length === 0) return;
    const bytes = data.length;
    // nx-9qsmb.6: doWrite() is try/catch-wrapped today and never rejects, but
    // that's an implicit invariant, not a guarantee — a future rejection here
    // would permanently poison the chain (every subsequent queued write
    // inherits the rejected promise and silently no-ops). Guard defensively
    // so the queue always stays in a resolved state.
    this.writeQueue = this.writeQueue.then(() => this.doWrite(text, bytes)).catch((err: unknown) => {
      logger.warn(
        { target: this.target, error: err instanceof Error ? err.message : String(err) },
        "tmux writeQueue: doWrite rejected unexpectedly — queue recovered",
      );
    });
  }

  private async doWrite(text: string, bytes: number): Promise<void> {
    if (this.closed) return;
    const argv = ["tmux", "send-keys", "-t", this.target, "-l", text];
    try {
      const proc = this.spawn.spawn(argv, {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      // NXPTY-DIAG (mx-rkir.13): log target + byte-count + exit code so we can
      // confirm a received keystroke actually reaches the tmux pane. The literal
      // text is intentionally NOT logged — it can contain pasted secrets.
      logger.info({ target: this.target, bytes }, "NXPTY tmux send-keys spawned");
      const code = await proc.exited;
      logger.info({ target: this.target, exitCode: code }, "NXPTY tmux send-keys exited");
    } catch (err) {
      logger.debug(
        { target: this.target, error: err instanceof Error ? err.message : String(err) },
        "tmux send-keys threw",
      );
    }
  }

  /**
   * Current pane geometry (last-observed). Viewers in lock mode size their
   * emulator grid to this value.
   */
  geometry(): { cols: number; rows: number } {
    return { ...this._geometry };
  }

  /**
   * Subscribe to geometry changes (detected on the read loop or after a
   * viewer-driven resize). Returns an unsubscribe function. The callback fires
   * AFTER the cached value updates, so `geometry()` reflects the new value.
   */
  onGeometryChange(
    callback: (geom: { cols: number; rows: number }) => void,
  ): () => void {
    this.geometryListeners.add(callback);
    return () => {
      this.geometryListeners.delete(callback);
    };
  }

  /**
   * Take-over resize: drive the tmux WINDOW to the viewer's grid so the viewer
   * can use its full frame. `tmux resize-window` only sticks when the
   * `window-size` option is `manual` (the default is usually `latest`/`largest`,
   * which auto-fits the largest attached client). So on the FIRST resize we
   * force `manual`; on last-viewer detach the release path UNSETS the option
   * (see `unsetWindowSize`) so tmux re-fits to whatever client is attached.
   *
   * NOTE: `resize-window` (window-level) is used, not `resize-pane` — a Claude
   * session is single-pane, so the pane follows the window, and resizing the
   * window is what actually changes the renderable grid the TUI composes for.
   */
  resize(cols: number, rows: number): void {
    if (this.closed) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
      return;
    }
    // Force window-size=manual ONCE so resize-window sticks. takeOverActive
    // marks that the release path must unset the option on last-viewer detach.
    if (!this.takeOverActive) {
      this.takeOverActive = true;
      this.setWindowSizeOption("manual");
    }
    try {
      const proc = this.spawn.spawnSync(
        ["tmux", "resize-window", "-t", this.target, "-x", String(cols), "-y", String(rows)],
        { stdout: "ignore", stderr: "pipe" },
      );
      if (proc.exitCode !== 0) {
        logger.debug(
          { target: this.target, cols, rows, err: proc.stderr.toString().trim() },
          "tmux resize-window non-zero",
        );
        return;
      }
    } catch (err) {
      logger.debug(
        { target: this.target, error: err instanceof Error ? err.message : String(err) },
        "tmux resize-window threw",
      );
      return;
    }
    // Re-sample so geometry() / listeners reflect the new size promptly.
    this.sampleGeometry();
  }

  /**
   * Release the take-over: UNSET the `window-size` option so tmux re-fits the
   * window to whatever client is attached. Called by the teardown path when the
   * last take-over viewer disconnects. No-op when take-over never forced the
   * option (`takeOverActive === false`), so a never-resized / read-only viewer
   * disconnect leaves tmux untouched (nx-cjhfv invariant).
   *
   * `window-size` is a SESSION-scope option: although `resize()` passes `-w`,
   * tmux applies the pin at session scope (verified live — `show-options -t
   * <session> -v window-size` shows `manual`). We unset at session scope (no
   * `-w` flag, mirroring Leo's proven `tmux set-option -t 0 -u window-size`)
   * so the pin can never survive release. Once unset the option inherits the
   * global default (`latest`) and tmux re-fits to the attached client — no
   * recorded geometry restore needed.
   */
  unsetWindowSize(): void {
    if (!this.takeOverActive) return;
    // STEP 1 — re-fit the window to the largest attached client BEFORE unsetting.
    // `set-option -u window-size` alone leaves the option back at the `latest`
    // default, but tmux does NOT immediately re-fit a `latest` window — it only
    // re-sizes on the next client activity/size-change. Verified live: after a
    // take-over shrank the window to 57x and the phone disconnected, the desktop
    // window stayed stranded at 57 (wsz=latest) until the user manually resized
    // his terminal. `resize-window -A` actively re-fits the window to the
    // largest/aggressive client (the desktop @ 317) right now, so the user's
    // pane snaps back the moment the phone detaches (mx-rkir.12 auto-restore).
    try {
      this.spawn.spawnSync(
        ["tmux", "resize-window", "-A", "-t", this.target],
        { stdout: "ignore", stderr: "ignore" },
      );
    } catch {
      // best-effort
    }
    // STEP 2 — unset the option so it inherits the global `latest` default and
    // tmux keeps auto-fitting to the attached client(s) thereafter.
    try {
      this.spawn.spawnSync(
        ["tmux", "set-option", "-u", "-t", this.target, "window-size"],
        { stdout: "ignore", stderr: "ignore" },
      );
    } catch {
      // best-effort
    }
    this.takeOverActive = false;
  }

  /** True when a take-over resize is currently active (option forced manual). */
  isTakeOverActive(): boolean {
    return this.takeOverActive;
  }

  /** Set the `window-size` option for this target. Best-effort. */
  private setWindowSizeOption(value: string): void {
    try {
      this.spawn.spawnSync(
        ["tmux", "set-option", "-w", "-t", this.target, "window-size", value],
        { stdout: "ignore", stderr: "ignore" },
      );
    } catch {
      // best-effort
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Detach the pipe on the tmux side. Issuing pipe-pane with no command
    // tears down the existing pipe for this target.
    try {
      const proc = this.spawn.spawnSync(["tmux", "pipe-pane", "-t", this.target], {
        stdout: "ignore",
        stderr: "ignore",
      });
      void proc;
    } catch {
      // tmux may already be gone — ignore
    }
    // Kill our local cat child so the ReadableStream completes.
    try {
      this.pipeChild?.kill();
    } catch {
      // already dead
    }
    this.pipeChild = null;
    // Clean up temp dir + FIFO.
    if (this.tmpDir) {
      try {
        rmSync(this.tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      this.tmpDir = null;
      this.fifoPath = null;
    }
    this.listeners.clear();
    this.geometryListeners.clear();
  }
}
