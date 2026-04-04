import { logger } from "@nexus/core";

const DEFAULT_SCROLLBACK_CAPACITY = 10_000;

/**
 * Abstraction over a terminal PTY — provides read, write, resize, and
 * scrollback capabilities.  Concrete implementations can read from
 * `/proc/{pid}/fd/`, a tmux capture pipe, or (for tests) a mock generator.
 */
export interface PtySource {
  /** Subscribe to new output data. Returns an unsubscribe function. */
  onData(callback: (data: Uint8Array) => void): () => void;

  /** Return the current scrollback buffer lines. */
  getScrollback(): string[];

  /** Write raw bytes to the PTY stdin. */
  write(data: Uint8Array): void;

  /** Resize the PTY. */
  resize(cols: number, rows: number): void;

  /** Tear down resources. */
  close(): void;
}

// ── Ring buffer ──────────────────────────────────────────────────────────────

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
    // Wrap-around: oldest is at `head`
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }
}

// ── Mock PTY source ──────────────────────────────────────────────────────────

export interface MockPtySourceOptions {
  /** Interval in ms between mock output lines (default 500). */
  intervalMs?: number;
  /** Scrollback buffer capacity (default 10 000). */
  scrollbackCapacity?: number;
}

/**
 * A mock PTY source that generates periodic output for testing.
 * Written bytes are echoed back to subscribers.
 */
export class MockPtySource implements PtySource {
  private listeners = new Set<(data: Uint8Array) => void>();
  private scrollback: RingBuffer;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lineCounter = 0;
  private closed = false;
  private _cols = 80;
  private _rows = 24;
  private _lastResize: { cols: number; rows: number } | null = null;

  /** Expose last resize for test assertions. */
  get lastResize() {
    return this._lastResize;
  }

  constructor(opts: MockPtySourceOptions = {}) {
    const capacity = opts.scrollbackCapacity ?? DEFAULT_SCROLLBACK_CAPACITY;
    this.scrollback = new RingBuffer(capacity);

    const intervalMs = opts.intervalMs ?? 500;
    if (intervalMs > 0) {
      this.timer = setInterval(() => {
        this.emit(`[mock] line ${++this.lineCounter}\n`);
      }, intervalMs);
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

  write(data: Uint8Array): void {
    if (this.closed) return;
    // Echo back
    this.emit(new TextDecoder().decode(data));
  }

  resize(cols: number, rows: number): void {
    this._cols = cols;
    this._rows = rows;
    this._lastResize = { cols, rows };
    logger.debug({ cols, rows }, "mock-pty: resize");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  // ── Helpers ──

  /** Manually push output (useful in tests). */
  emit(text: string): void {
    if (this.closed) return;
    const bytes = new TextEncoder().encode(text);
    // Record in scrollback (split by newline)
    for (const line of text.split("\n")) {
      if (line.length > 0) this.scrollback.push(line);
    }
    for (const cb of this.listeners) {
      try {
        cb(bytes);
      } catch {
        // subscriber threw — ignore
      }
    }
  }
}
