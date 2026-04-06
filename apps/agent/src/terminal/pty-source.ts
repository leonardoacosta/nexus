import type * as NodePtyTypes from "node-pty";

const DEFAULT_SCROLLBACK_CAPACITY = 10_000;

/**
 * Environment variable keys that must never be forwarded to a child PTY process.
 *
 * These variables contain secrets or connection strings that have no legitimate
 * use inside a spawned shell session and could be exfiltrated by malicious
 * terminal payloads.
 *
 * PATH and HOME are intentionally excluded — they are required for a usable shell.
 */
export const SENSITIVE_ENV_KEYS: ReadonlyArray<string> = [
  "NEXUS_ATTACH_SECRET",
  "NEXUS_ENCRYPTION_KEY",
  "NEXUS_INTERNAL_SECRET",
  "POSTGRES_URL",
  "DATABASE_URL",
  "SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
];

// Minimal logger interface used by this module.
// We intentionally avoid importing @nexus/core (pino) at module level because
// pino's stream initialization interferes with node-pty's libuv data callbacks
// in bun's test runner (bun 1.3.x). Debug messages in this module are low-value;
// callers who need PTY logs should set up their own tracing.
const noopLog = {
  debug: (..._args: unknown[]) => {},
};

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

// ── Concrete PTY source backed by node-pty ───────────────────────────────────

export interface NodePtySourceOptions {
  /** Columns (default 80). */
  cols?: number;
  /** Rows (default 24). */
  rows?: number;
  /** Working directory for the spawned process (default process.cwd()). */
  cwd?: string;
  /** Scrollback buffer capacity (default 10 000). */
  scrollbackCapacity?: number;
  /** Environment variables passed to the child process (default process.env). */
  env?: Record<string, string>;
}

/**
 * A concrete PtySource that spawns a real PTY process via node-pty.
 * Use MockPtySource in tests.
 */
export class NodePtySource implements PtySource {
  private term: NodePtyTypes.IPty;
  private scrollback: RingBuffer;
  private listeners = new Set<(data: Uint8Array) => void>();
  private closed = false;

  constructor(
    shell: string,
    args: string[],
    opts: NodePtySourceOptions = {},
  ) {
    const capacity = opts.scrollbackCapacity ?? DEFAULT_SCROLLBACK_CAPACITY;
    this.scrollback = new RingBuffer(capacity);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pty = require("node-pty") as typeof NodePtyTypes;

    // When the caller does not supply an explicit env, build a sanitised copy of
    // process.env with all sensitive keys removed so secrets are never forwarded
    // to child shell sessions. When env is supplied explicitly (e.g. in tests),
    // pass it as-is — the caller controls what is included.
    let spawnEnv: Record<string, string>;
    if (opts.env !== undefined) {
      spawnEnv = opts.env;
    } else {
      spawnEnv = { ...(process.env as Record<string, string>) };
      for (const key of SENSITIVE_ENV_KEYS) {
        delete spawnEnv[key];
      }
    }

    this.term = pty.spawn(shell, args, {
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd ?? process.cwd(),
      env: spawnEnv,
      // Request binary mode — node-pty may still deliver strings on some platforms
      encoding: null as unknown as undefined,
    });

    this.term.onData((data: string | Uint8Array) => {
      const bytes =
        typeof data === "string" ? new TextEncoder().encode(data) : data;
      const text = new TextDecoder().decode(bytes);
      // Always update scrollback even if closed — allows callers to read buffered
      // output from a process that exited before onData could be observed.
      for (const line of text.split("\n")) {
        if (line.length > 0) this.scrollback.push(line);
      }
      if (this.closed) return;
      for (const cb of this.listeners) {
        try {
          cb(bytes);
        } catch {
          // subscriber threw — ignore
        }
      }
    });

    this.term.onExit(() => {
      this.closed = true;
      this.listeners.clear();
      noopLog.debug({ shell }, "node-pty: process exited");
    });
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
    this.term.write(data as unknown as string);
  }

  resize(cols: number, rows: number): void {
    if (this.closed) return;
    try {
      this.term.resize(cols, rows);
    } catch {
      // ignore if process is gone
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.term.kill();
    } catch {
      // already dead
    }
    this.listeners.clear();
    noopLog.debug("node-pty: closed");
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
    noopLog.debug({ cols, rows }, "mock-pty: resize");
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
