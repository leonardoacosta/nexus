"use client";

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { fetchWithTimeout } from "@nexus/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TerminalMode = "stream" | "interact";

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

export interface XTerminalProps {
  agentHost: string;
  sessionId: string;
  mode: TerminalMode;
  /** Called when the agent or session sends a control frame */
  onControlFrame?: (data: ControlFrame) => void;
  /**
   * Optional pre-fetched WebSocket auth token. When omitted, XTerminal will
   * fetch it from `/api/ws-token` before opening the connection.
   * Pass an explicit value to avoid the extra round-trip (e.g. from a server
   * component that already has the secret in scope).
   */
  wsToken?: string;
}

export interface XTerminalHandle {
  /** Get current connection status */
  getStatus: () => ConnectionStatus;
}

interface ControlFrame {
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000; // 1s, 2s, 4s

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const XTerminal = forwardRef<XTerminalHandle, XTerminalProps>(
  function XTerminal({ agentHost, sessionId, mode, onControlFrame, wsToken }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
    const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const retryCountRef = useRef(0);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);
    // Resolved token — set once during init and reused by reconnect attempts.
    const tokenRef = useRef<string | null>(wsToken ?? null);

    const [status, setStatus] = useState<ConnectionStatus>("disconnected");

    // Expose handle
    useImperativeHandle(ref, () => ({ getStatus: () => status }), [status]);

    // -----------------------------------------------------------------------
    // WebSocket connection
    // -----------------------------------------------------------------------

    const connectWs = useCallback(
      (term: import("@xterm/xterm").Terminal) => {
        // Clean up any existing connection
        if (wsRef.current) {
          wsRef.current.onopen = null;
          wsRef.current.onmessage = null;
          wsRef.current.onclose = null;
          wsRef.current.onerror = null;
          wsRef.current.close();
          wsRef.current = null;
        }

        const protocol = agentHost.startsWith("localhost") || agentHost.startsWith("127.0.0.1")
          ? "ws"
          : "ws"; // Agent doesn't serve TLS — Tailscale handles encryption
        let url = `${protocol}://${agentHost}/sessions/${encodeURIComponent(sessionId)}/${mode}`;

        // Append the auth token as a query-string parameter so browsers can
        // authenticate WebSocket upgrades (custom headers not allowed in browser WS).
        const token = tokenRef.current;
        if (token) {
          url += `?token=${encodeURIComponent(token)}`;
        }

        const ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onopen = () => {
          if (!mountedRef.current) return;
          retryCountRef.current = 0;
          setStatus("connected");

          // In interact mode, send initial resize
          if (mode === "interact") {
            ws.send(
              JSON.stringify({
                type: "resize",
                cols: term.cols,
                rows: term.rows,
              }),
            );
          }
        };

        ws.onmessage = (event: MessageEvent) => {
          if (!mountedRef.current) return;

          if (event.data instanceof ArrayBuffer) {
            // Binary frame → terminal output
            term.write(new Uint8Array(event.data));
          } else if (typeof event.data === "string") {
            // JSON control frame
            try {
              const frame = JSON.parse(event.data) as ControlFrame;
              onControlFrame?.(frame);

              if (frame.type === "session_ended") {
                setStatus("disconnected");
                // Don't retry — session is gone
                retryCountRef.current = MAX_RETRIES;
              }
            } catch {
              // Not JSON — write as text
              term.write(event.data);
            }
          }
        };

        ws.onclose = () => {
          if (!mountedRef.current) return;

          if (retryCountRef.current < MAX_RETRIES) {
            setStatus("reconnecting");
            const delay = BACKOFF_BASE_MS * Math.pow(2, retryCountRef.current);
            retryCountRef.current++;

            retryTimerRef.current = setTimeout(() => {
              if (mountedRef.current) {
                connectWs(term);
              }
            }, delay);
          } else {
            setStatus("disconnected");
          }
        };

        ws.onerror = () => {
          // onclose will fire after onerror — reconnection handled there
        };
      },
      [agentHost, sessionId, mode, onControlFrame],
      // tokenRef is a ref — mutations don't need to be in deps
    );

    // -----------------------------------------------------------------------
    // Terminal initialization + cleanup
    // -----------------------------------------------------------------------

    useEffect(() => {
      mountedRef.current = true;

      let term: import("@xterm/xterm").Terminal | null = null;
      let fitAddon: import("@xterm/addon-fit").FitAddon | null = null;
      let resizeObserver: ResizeObserver | null = null;

      async function init() {
        if (!containerRef.current || !mountedRef.current) return;

        // Fetch the WebSocket auth token if not pre-provided via prop.
        // The /api/ws-token route returns the secret server-side so it is never
        // embedded in static client bundles.
        if (!tokenRef.current) {
          try {
            const res = await fetchWithTimeout("/api/ws-token");
            if (res.ok) {
              const data = (await res.json()) as { token?: string };
              if (data.token) tokenRef.current = data.token;
            }
          } catch {
            // Non-fatal: connect will proceed without a token and receive 401
          }
        }

        if (!mountedRef.current) return;

        // Dynamic imports — xterm needs real DOM
        const { Terminal } = await import("@xterm/xterm");
        const { FitAddon } = await import("@xterm/addon-fit");

        if (!mountedRef.current || !containerRef.current) return;

        term = new Terminal({
          cursorBlink: mode === "interact",
          cursorStyle: mode === "interact" ? "block" : "underline",
          fontFamily: "var(--font-geist-mono, 'Geist Mono'), 'SF Mono', 'Cascadia Code', monospace",
          fontSize: 13,
          lineHeight: 1.4,
          theme: {
            background: "#0A0A0B",
            foreground: "#FAFAFA",
            cursor: "#3B82F6",
            selectionBackground: "rgba(59, 130, 246, 0.3)",
            black: "#0A0A0B",
            red: "#EF4444",
            green: "#22C55E",
            yellow: "#EAB308",
            blue: "#3B82F6",
            magenta: "#A855F7",
            cyan: "#06B6D4",
            white: "#FAFAFA",
            brightBlack: "#52525B",
            brightRed: "#F87171",
            brightGreen: "#4ADE80",
            brightYellow: "#FACC15",
            brightBlue: "#60A5FA",
            brightMagenta: "#C084FC",
            brightCyan: "#22D3EE",
            brightWhite: "#FFFFFF",
          },
          scrollback: 5000,
          allowProposedApi: true,
        });

        terminalRef.current = term;

        fitAddon = new FitAddon();
        fitAddonRef.current = fitAddon;
        term.loadAddon(fitAddon);

        // Try loading WebGL renderer
        try {
          const { WebglAddon } = await import("@xterm/addon-webgl");
          if (mountedRef.current) {
            const webglAddon = new WebglAddon();
            webglAddon.onContextLoss(() => {
              webglAddon.dispose();
            });
            term.loadAddon(webglAddon);
          }
        } catch {
          // WebGL not available — canvas fallback is automatic
        }

        term.open(containerRef.current);
        fitAddon.fit();

        // In interactive mode, forward keyboard input as binary
        if (mode === "interact") {
          term.onData((data: string) => {
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(new TextEncoder().encode(data));
            }
          });

          term.onBinary((data: string) => {
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              const buffer = new Uint8Array(data.length);
              for (let i = 0; i < data.length; i++) {
                buffer[i] = data.charCodeAt(i);
              }
              ws.send(buffer);
            }
          });
        }

        // Auto-fit on container resize
        resizeObserver = new ResizeObserver(() => {
          if (fitAddon && mountedRef.current) {
            try {
              fitAddon.fit();

              // Send resize to agent in interact mode
              if (mode === "interact" && wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(
                  JSON.stringify({
                    type: "resize",
                    cols: term!.cols,
                    rows: term!.rows,
                  }),
                );
              }
            } catch {
              // Container might be hidden or zero-sized
            }
          }
        });
        resizeObserver.observe(containerRef.current);

        // Connect WebSocket
        connectWs(term);
      }

      init();

      return () => {
        mountedRef.current = false;

        if (retryTimerRef.current) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }

        if (wsRef.current) {
          wsRef.current.onopen = null;
          wsRef.current.onmessage = null;
          wsRef.current.onclose = null;
          wsRef.current.onerror = null;
          wsRef.current.close();
          wsRef.current = null;
        }

        resizeObserver?.disconnect();

        if (term) {
          term.dispose();
          terminalRef.current = null;
          fitAddonRef.current = null;
        }
      };
    }, [agentHost, sessionId, mode, connectWs]);

    // -----------------------------------------------------------------------
    // Prevent browser shortcuts when terminal focused in interact mode
    // -----------------------------------------------------------------------

    useEffect(() => {
      if (mode !== "interact") return;

      const container = containerRef.current;
      if (!container) return;

      function handleKeyDown(e: KeyboardEvent) {
        // Prevent browser shortcuts like Ctrl+W, Ctrl+T, Ctrl+N when focused
        if (e.ctrlKey || e.metaKey) {
          const key = e.key.toLowerCase();
          if (["w", "t", "n", "r", "l"].includes(key)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }
      }

      container.addEventListener("keydown", handleKeyDown, { capture: true });
      return () => container.removeEventListener("keydown", handleKeyDown, { capture: true });
    }, [mode]);

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    return (
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        {/* Connection status indicator */}
        <div
          data-testid="connection-status"
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: "var(--radius-full)",
            background: "rgba(0, 0, 0, 0.6)",
            backdropFilter: "blur(4px)",
            fontSize: "var(--font-size-xs)",
            color: "var(--color-fg-dim)",
          }}
        >
          <span
            data-testid="status-dot"
            role="status"
            aria-label={status}
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background:
                status === "connected"
                  ? "var(--color-success)"
                  : status === "reconnecting"
                    ? "var(--color-warning)"
                    : "var(--color-error)",
              boxShadow:
                status === "connected"
                  ? "var(--shadow-glow-success)"
                  : status === "reconnecting"
                    ? "0 0 12px rgba(234, 179, 8, 0.25)"
                    : "var(--shadow-glow-error)",
            }}
          />
          <span data-testid="status-text">
            {status === "connected"
              ? "Connected"
              : status === "reconnecting"
                ? "Reconnecting..."
                : "Disconnected"}
          </span>
        </div>

        {/* Terminal container */}
        <div
          ref={containerRef}
          data-testid="terminal-container"
          style={{
            width: "100%",
            height: "100%",
            background: "#0A0A0B",
            borderRadius: "var(--radius-lg)",
            overflow: "hidden",
          }}
        />
      </div>
    );
  },
);
