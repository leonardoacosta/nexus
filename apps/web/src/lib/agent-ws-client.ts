/**
 * Browser WebSocket client for the Nexus agent PTY attach spine.
 *
 * This is the browser analogue of Swift `NexusClient.consumePtyStream` /
 * `openInteract` / `sendInteractiveInput` / `requestResize`
 * (`apps/swift/NexusShared/Networking/NexusClient.swift`). It speaks the agent
 * protocol DIRECTLY (`apps/agent/src/server-websocket.ts` +
 * `terminal/stream-manager.ts`) — we deliberately do NOT vendor wterm's
 * `WebSocketTransport`, because the agent protocol is richer:
 *
 *   - `GET /sessions/:id/stream`   — read channel. The agent sends a TEXT
 *       `{"type":"geometry",cols,rows}` FIRST, then BINARY scrollback bytes,
 *       then live BINARY PTY bytes. On reconnect the client sends TEXT
 *       `{"type":"reconnect","sessionId":...}`; the agent replays its ring
 *       buffer (BINARY) followed by TEXT `{"type":"replay_done"}`.
 *   - `GET /sessions/:id/interact` — write channel. Claims the writer mutex.
 *       Client sends stdin as BINARY frames and resize as TEXT
 *       `{"type":"resize",cols,rows}`. If another client already holds the
 *       mutex, the agent closes with application code 4009 — the client marks
 *       the session read-only WITHOUT throwing.
 *
 * RENDERER-AGNOSTIC: this module exposes bytes / geometry / status via
 * callbacks. It does NOT import `@wterm/*`. The UI layer wires
 * `onBytes` -> `core.writeRaw`, `onGeometry` -> `core.resize`, and
 * `core.getResponse()` -> `sendInput`. Keeping transport and renderer
 * decoupled is the whole architecture.
 */

import { toWsUrl } from "./agent-config";

// ── Public types the UI batch imports ───────────────────────────────────────

/**
 * Connection lifecycle status, surfaced to the UI for a status indicator.
 *
 * - `connecting` — socket opening (initial connect or mid-reconnect).
 * - `live`       — stream is open and (after any replay) delivering live bytes.
 * - `read-only`  — attached for output, but the interact writer mutex is held
 *                  elsewhere (4009) or the interact channel failed; input is
 *                  suppressed. The READ stream is still live.
 * - `closed`     — the client was closed by the caller, or the session ended.
 */
export type ConnectionStatus = "connecting" | "live" | "read-only" | "closed";

/** Geometry control frame payload. */
export interface Geometry {
  cols: number;
  rows: number;
}

/** Callbacks the UI provides to drive the renderer + status UI. */
export interface AgentStreamHandlers {
  /** Raw PTY output bytes (BINARY frames). Wire to `core.writeRaw`. */
  onBytes?: (bytes: Uint8Array) => void;
  /** Source-pane geometry (TEXT `geometry` frame). Wire to `core.resize`. */
  onGeometry?: (geom: Geometry) => void;
  /**
   * Fired when the agent finishes replaying its reconnect ring buffer
   * (TEXT `replay_done`). The replayed bytes have already been delivered via
   * `onBytes`; this marks the boundary after which output is live again.
   */
  onReplayDone?: () => void;
  /** Connection status transitions, for a status indicator. */
  onStatus?: (status: ConnectionStatus) => void;
}

/** Construction options for {@link AgentSessionClient}. */
export interface AgentSessionClientOptions {
  /** Agent base URL, e.g. `http://100.73.182.4:7400` (from NEXT_PUBLIC_…). */
  agentBaseUrl: string;
  /** Target session id. */
  sessionId: string;
  /** Renderer + status callbacks. */
  handlers?: AgentStreamHandlers;
  /**
   * Whether to open the interact (write) channel. When `false` the client is
   * read-only by construction (stream channel only). Default `true`.
   */
  interactive?: boolean;
  /**
   * Base reconnect backoff in ms (doubles up to {@link maxBackoffMs}).
   * Default 500.
   */
  baseBackoffMs?: number;
  /** Max reconnect backoff in ms. Default 10_000. */
  maxBackoffMs?: number;
}

// ── Control-frame parsing ───────────────────────────────────────────────────

interface GeometryFrame {
  type: "geometry";
  cols: number;
  rows: number;
}
interface ReplayDoneFrame {
  type: "replay_done";
}

/**
 * Parse an agent TEXT control frame. Returns `null` for anything we don't
 * route (malformed JSON, unknown `type`, `writer_disconnected`,
 * `session_ended`, etc. — those are handled separately or ignored).
 */
function parseControlFrame(
  text: string,
): GeometryFrame | ReplayDoneFrame | { type: string } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  const type = rec.type;
  if (type === "geometry") {
    const cols = Number(rec.cols);
    const rows = Number(rec.rows);
    if (Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0) {
      return { type: "geometry", cols, rows };
    }
    return null;
  }
  if (type === "replay_done") return { type: "replay_done" };
  if (typeof type === "string") return { type };
  return null;
}

/** Normalize a WS binary payload (ArrayBuffer | Blob handled by caller) to Uint8Array. */
function toBytes(data: ArrayBuffer): Uint8Array {
  return new Uint8Array(data);
}

// ── The client ──────────────────────────────────────────────────────────────

/**
 * Manages the read (`/stream`) and write (`/interact`) WebSocket channels for
 * a single session, including reconnect-with-replay and the 4009 read-only
 * degrade. Construct, then call {@link connect}. Call {@link close} to tear
 * down (idempotent).
 */
export class AgentSessionClient {
  private readonly agentBaseUrl: string;
  private readonly sessionId: string;
  private readonly handlers: AgentStreamHandlers;
  private readonly interactive: boolean;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  private streamSocket: WebSocket | null = null;
  private interactSocket: WebSocket | null = null;

  /** True once the stream socket has opened at least once (so a drop = reconnect). */
  private hasConnectedOnce = false;
  /** Whether a reconnect is in flight (drives the `reconnect` replay request). */
  private reconnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set when the writer mutex is denied (4009) or the interact channel fails. */
  private readOnly = false;
  /** Set by {@link close}; suppresses reconnect. */
  private closed = false;

  private status: ConnectionStatus = "connecting";

  constructor(opts: AgentSessionClientOptions) {
    this.agentBaseUrl = opts.agentBaseUrl;
    this.sessionId = opts.sessionId;
    this.handlers = opts.handlers ?? {};
    this.interactive = opts.interactive ?? true;
    this.baseBackoffMs = opts.baseBackoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 10_000;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Open the stream channel (and the interact channel if interactive). */
  connect(): void {
    if (this.closed) return;
    this.openStream();
    if (this.interactive) {
      this.openInteract();
    } else {
      // Read-only by construction.
      this.readOnly = true;
    }
  }

  /** Tear down both channels. Idempotent. No reconnect after this. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket(this.streamSocket);
    this.streamSocket = null;
    this.teardownSocket(this.interactSocket);
    this.interactSocket = null;
    this.setStatus("closed");
  }

  /** Current connection status. */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /** True when input + resize are suppressed (writer mutex held elsewhere). */
  isReadOnly(): boolean {
    return this.readOnly;
  }

  // ── Write side (interact channel) ──────────────────────────────────────────

  /**
   * Send stdin bytes over the interact channel as a BINARY frame. No-op when
   * read-only or the interact socket is not open. Mirrors Swift
   * `sendInteractiveInput` — bytes are forwarded verbatim (no appended Enter).
   *
   * The UI wires this to `@wterm/dom` `onData` (string -> bytes) AND to
   * `core.getResponse()` for terminal replies (DSR/DA).
   */
  sendInput(data: Uint8Array | string): void {
    if (this.readOnly) return;
    const sock = this.interactSocket;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    try {
      sock.send(bytes);
    } catch {
      // dead socket — the close handler will flip read-only / reconnect.
    }
  }

  /**
   * Send a resize control frame over the interact channel as TEXT
   * `{"type":"resize",cols,rows}`. No-op when read-only or not open. The UI
   * wires this to `@wterm/dom` `onResize`.
   */
  sendResize(cols: number, rows: number): void {
    if (this.readOnly) return;
    const sock = this.interactSocket;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    try {
      sock.send(JSON.stringify({ type: "resize", cols, rows }));
    } catch {
      // dead socket — ignored.
    }
  }

  // ── Stream channel ─────────────────────────────────────────────────────────

  private openStream(): void {
    const url = toWsUrl(this.agentBaseUrl, `/sessions/${this.sessionId}/stream`);
    if (!url) {
      // Unconstructable URL / bad scheme — nothing to attach to.
      this.setStatus("closed");
      return;
    }
    this.setStatus("connecting");
    const sock = new WebSocket(url);
    sock.binaryType = "arraybuffer";
    this.streamSocket = sock;

    sock.addEventListener("open", () => {
      if (this.reconnecting) {
        // Ask the agent to replay its ring buffer before live output resumes.
        // The replayed bytes arrive via onBytes; `replay_done` marks live.
        try {
          sock.send(
            JSON.stringify({ type: "reconnect", sessionId: this.sessionId }),
          );
        } catch {
          // if the send fails the socket will error/close and we retry.
        }
      }
      this.hasConnectedOnce = true;
      this.reconnecting = false;
      this.reconnectAttempts = 0;
      // Status: live unless the interact side already marked us read-only.
      this.setStatus(this.readOnly ? "read-only" : "live");
    });

    sock.addEventListener("message", (ev: MessageEvent) => {
      this.handleStreamMessage(ev.data);
    });

    sock.addEventListener("close", () => {
      if (this.closed) return;
      // The read stream dropped. Schedule a reconnect-with-replay.
      this.scheduleReconnect();
    });

    sock.addEventListener("error", () => {
      // `error` is always followed by `close`; let close drive reconnect.
    });
  }

  private handleStreamMessage(data: unknown): void {
    // BINARY: raw PTY bytes.
    if (data instanceof ArrayBuffer) {
      this.handlers.onBytes?.(toBytes(data));
      return;
    }
    if (data instanceof Blob) {
      // Defensive: we set binaryType=arraybuffer, but handle Blob too.
      void data.arrayBuffer().then((buf) => this.handlers.onBytes?.(toBytes(buf)));
      return;
    }
    // TEXT: JSON control frame.
    if (typeof data === "string") {
      const frame = parseControlFrame(data);
      if (!frame) return;
      if (frame.type === "geometry") {
        const g = frame as GeometryFrame;
        this.handlers.onGeometry?.({ cols: g.cols, rows: g.rows });
        return;
      }
      if (frame.type === "replay_done") {
        this.handlers.onReplayDone?.();
        this.setStatus(this.readOnly ? "read-only" : "live");
        return;
      }
      if (frame.type === "session_ended") {
        this.close();
        return;
      }
      // writer_disconnected / error / unknown — ignored on the read channel.
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.teardownSocket(this.streamSocket);
    this.streamSocket = null;
    this.reconnecting = this.hasConnectedOnce;
    this.setStatus("connecting");

    const delay = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.openStream();
    }, delay);
  }

  // ── Interact channel ───────────────────────────────────────────────────────

  private openInteract(): void {
    const url = toWsUrl(
      this.agentBaseUrl,
      `/sessions/${this.sessionId}/interact`,
    );
    if (!url) {
      // Can't build the interact URL — degrade to read-only, never throw.
      this.markReadOnly();
      return;
    }
    const sock = new WebSocket(url);
    sock.binaryType = "arraybuffer";
    this.interactSocket = sock;

    sock.addEventListener("open", () => {
      // Writer mutex claimed (if it weren't, the agent would close with 4009).
      // Leave readOnly as-is; status follows the stream channel.
    });

    sock.addEventListener("message", (ev: MessageEvent) => {
      // The agent only emits control replies on interact (e.g.
      // {"type":"error","message":"not the interactive writer"}). Treat any
      // such error as a read-only signal — input would be ignored anyway.
      if (typeof ev.data === "string") {
        try {
          const obj = JSON.parse(ev.data) as { type?: string };
          if (obj.type === "error") this.markReadOnly();
        } catch {
          // ignore non-JSON
        }
      }
    });

    sock.addEventListener("close", (ev: CloseEvent) => {
      // 4009 == writer mutex held by another client -> read-only, no throw.
      // Any other close while not torn down also means input can't flow.
      if (ev.code === 4009) {
        this.markReadOnly();
        return;
      }
      if (this.closed) return;
      // Lost the interact channel (not a deliberate close): degrade to
      // read-only. We do NOT reconnect interact automatically — the writer
      // mutex semantics mean a silent re-claim could steal control. The read
      // stream keeps flowing; the UI can offer an explicit re-attach.
      this.markReadOnly();
    });

    sock.addEventListener("error", () => {
      // Followed by close; close handler degrades to read-only.
    });
  }

  private markReadOnly(): void {
    if (this.readOnly) return;
    this.readOnly = true;
    // Only surface read-only once the read stream is up; before that the
    // status is still `connecting`.
    if (this.status === "live") this.setStatus("read-only");
    else if (this.status === "connecting" && this.hasConnectedOnce) {
      this.setStatus("read-only");
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.handlers.onStatus?.(next);
  }

  private teardownSocket(sock: WebSocket | null): void {
    if (!sock) return;
    // Drop handlers so a late close/error doesn't trigger reconnect after we
    // intentionally replaced/closed the socket.
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    sock.onerror = null;
    try {
      sock.close();
    } catch {
      // already closing/closed
    }
  }
}

/**
 * Convenience factory mirroring the Swift call sites: open a fully-interactive
 * attach client and connect immediately. Returns the client for input/resize
 * + teardown.
 */
export function attachSession(
  opts: AgentSessionClientOptions,
): AgentSessionClient {
  const client = new AgentSessionClient(opts);
  client.connect();
  return client;
}
