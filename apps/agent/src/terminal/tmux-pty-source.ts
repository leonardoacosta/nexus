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
 * Resize is a no-op — tmux owns the pane geometry; viewers cannot resize a
 * pane that real users are also looking at. Future work can wire this up
 * via `tmux refresh-client -C` once a single-viewer mode is defined.
 *
 * Spec: nx-omso0 — fix(agent): lazy-attach tmux PtySource on
 *   /sessions/<id>/stream upgrade.
 */

import { logger } from "@nexus/core/node";
import type { PtySource } from "./pty-source";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_SCROLLBACK_CAPACITY = 10_000;
const SCROLLBACK_LINES = 1000;
const TMUX_TARGET_RE = /^[A-Za-z0-9_.:%@/-]+$/;

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

export interface TmuxPtySourceOptions {
  /** Scrollback buffer capacity (default 10 000). */
  scrollbackCapacity?: number;
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

  constructor(
    private readonly target: string,
    opts: TmuxPtySourceOptions = {},
  ) {
    const capacity = opts.scrollbackCapacity ?? DEFAULT_SCROLLBACK_CAPACITY;
    this.scrollback = new RingBuffer(capacity);
    this.seedScrollback();
    this.startPipePane();
  }

  /**
   * Read recent pane contents synchronously at attach so viewers see
   * context immediately. Best-effort — tmux missing or pane gone yields
   * an empty scrollback (the stream will still work).
   */
  private seedScrollback(): void {
    try {
      const proc = Bun.spawnSync(
        [
          "tmux",
          "capture-pane",
          "-p",
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
      const mkfifo = Bun.spawnSync(["mkfifo", this.fifoPath], {
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
      const reader = Bun.spawn(["cat", this.fifoPath], {
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
      const setup = Bun.spawnSync(
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
        // Record raw bytes' textual form in scrollback (line-split).
        try {
          const text = new TextDecoder("utf-8", { fatal: false }).decode(value);
          for (const line of text.split("\n")) {
            if (line.length > 0) this.scrollback.push(line);
          }
        } catch {
          // ignore decode errors — still forward bytes to listeners
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
   * Write bytes into the tmux pane via `send-keys`. Best-effort,
   * fire-and-forget — failures are logged at debug level only.
   */
  write(data: Uint8Array): void {
    if (this.closed) return;
    const text = new TextDecoder().decode(data);
    if (text.length === 0) return;
    try {
      const proc = Bun.spawn(["tmux", "send-keys", "-t", this.target, "-l", text], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      void proc.exited;
    } catch (err) {
      logger.debug(
        { target: this.target, error: err instanceof Error ? err.message : String(err) },
        "tmux send-keys threw",
      );
    }
  }

  /**
   * tmux pane geometry is owned by tmux itself; viewer-driven resize is
   * unsafe (would affect every real user attached to the same pane). No-op
   * by design.
   */
  resize(_cols: number, _rows: number): void {
    // intentionally empty
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Detach the pipe on the tmux side. Issuing pipe-pane with no command
    // tears down the existing pipe for this target.
    try {
      const proc = Bun.spawnSync(["tmux", "pipe-pane", "-t", this.target], {
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
  }
}
