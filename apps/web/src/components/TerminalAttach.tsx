"use client";

import { useEffect, useRef, useState } from "react";
import { WTerm } from "@wterm/dom";
import { GhosttyCore } from "@wterm/ghostty";
import "@wterm/dom/css";

import type { AgentSessionClient, ConnectionStatus } from "~/lib";
import { attachSession } from "~/lib";

import { StatusPill } from "./StatusPill";
import { theme } from "./theme";

/**
 * Fully-interactive terminal attach view. Mounts the `@wterm/ghostty` VT core
 * (libghostty WASM) under the `@wterm/dom` `WTerm` orchestrator and wires it to
 * the renderer-agnostic transport client from `~/lib`.
 *
 * Integration seam (design.md), with the REAL `@wterm/dom@0.3.0` API:
 *
 *   transport.onBytes(Uint8Array)        -> term.write(bytes)   (-> core.writeRaw)
 *   transport.onGeometry({cols,rows})    -> term.resize(c,r)    (-> core.resize)
 *   WTerm.onData(string)                 -> transport.sendInput  (keystrokes AND
 *                                            DSR/DA replies — see note below)
 *   WTerm.onResize(cols,rows)            -> transport.sendResize
 *
 * NOTE ON `getResponse()`: the audit suggested manually polling
 * `core.getResponse()` and routing it to `/interact`. That is unnecessary with
 * `@wterm/dom@0.3.0` — `WTerm._doRender()` already calls `bridge.getResponse()`
 * after every render and pushes the result through `onData`. So the single
 * `onData -> sendInput` wiring carries BOTH user keystrokes (task 3.3) and
 * terminal replies / DSR / DA (task 3.2). Re-adding a manual poll would
 * double-send the responses.
 *
 * GEOMETRY-BEFORE-BYTES RACE: `attachSession()` connects synchronously, so
 * `onBytes` / `onGeometry` can fire before the WASM finishes loading. We buffer
 * inbound frames until the term is ready, then apply the latest geometry FIRST
 * and flush the buffered bytes — so early scrollback never wraps against the
 * default 80x24 grid.
 *
 * READ-ONLY: when the writer mutex is held elsewhere (4009) the transport marks
 * itself read-only and `sendInput`/`sendResize` become no-ops. We also gate the
 * emission here and surface the state via the StatusPill, so a read-only attach
 * still renders live output but cannot type or resize the remote pane.
 */
export function TerminalAttach({
  sessionId,
  agentBaseUrl,
}: {
  sessionId: string;
  /** Resolved agent base URL (from NEXT_PUBLIC_NEXUS_AGENT_URL via the page). */
  agentBaseUrl: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let term: WTerm | null = null;
    let client: AgentSessionClient | null = null;

    // Frames that arrive before the term is mounted are buffered here and
    // flushed (geometry first) once the renderer is ready.
    let ready = false;
    const pendingBytes: Uint8Array[] = [];
    // A holder object (not a reassigned `let`) so TS doesn't narrow the field
    // to `never` inside the async closure that reads it after the callbacks
    // mutate it.
    const pending: { geometry: { cols: number; rows: number } | null } = {
      geometry: null,
    };

    const applyGeometry = (cols: number, rows: number) => {
      // Drives core.resize(cols, rows). Must precede the byte flush.
      term?.resize(cols, rows);
    };

    const feed = (bytes: Uint8Array) => {
      // Drives core.writeRaw(bytes) and schedules a render.
      term?.write(bytes);
    };

    // 1) Open the transport FIRST so we never miss the agent's opening
    //    geometry frame or the scrollback burst (both buffered until ready).
    client = attachSession({
      agentBaseUrl,
      sessionId,
      handlers: {
        onStatus: (s) => {
          if (!disposed) setStatus(s);
        },
        onGeometry: (g) => {
          if (disposed) return;
          if (ready) applyGeometry(g.cols, g.rows);
          else pending.geometry = g;
        },
        onBytes: (b) => {
          if (disposed) return;
          if (ready) feed(b);
          else pendingBytes.push(b);
        },
      },
    });

    // 2) Load WASM + mount the renderer. `wasmPath` points at the Next-served
    //    public asset; the loader uses single-arg `fetch` + `instantiate`
    //    (no COOP/COEP). `core` is passed to WTerm, which owns the renderer,
    //    input keymap, and the ResizeObserver.
    void (async () => {
      try {
        const core = await GhosttyCore.load({ wasmPath: "/ghostty-vt.wasm" });
        if (disposed) return;

        const wterm = new WTerm(host, {
          core,
          // Agent's opening geometry frame resizes to the real source pane;
          // this is just the pre-replay grid.
          cols: pending.geometry?.cols ?? 80,
          rows: pending.geometry?.rows ?? 24,
          autoResize: true,
          onData: (data) => {
            // Keystrokes + terminal replies. No-op upstream when read-only.
            if (client && !client.isReadOnly()) client.sendInput(data);
          },
          onResize: (cols, rows) => {
            // ResizeObserver-driven. No-op upstream when read-only.
            if (client && !client.isReadOnly()) client.sendResize(cols, rows);
          },
        });
        await wterm.init();
        if (disposed) {
          wterm.destroy();
          return;
        }
        term = wterm;
        ready = true;

        // Flush buffered frames: geometry FIRST, then bytes.
        if (pending.geometry) {
          applyGeometry(pending.geometry.cols, pending.geometry.rows);
          pending.geometry = null;
        }
        for (const b of pendingBytes) feed(b);
        pendingBytes.length = 0;

        wterm.focus();
      } catch (err) {
        if (disposed) return;
        setError(
          err instanceof Error ? err.message : "Failed to load terminal renderer",
        );
      }
    })();

    // 3) Clean teardown: stop the transport, dispose the core/renderer.
    return () => {
      disposed = true;
      client?.close();
      term?.destroy();
      term = null;
      client = null;
    };
  }, [sessionId, agentBaseUrl]);

  const readOnly = status === "read-only";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          borderBottom: `1px solid ${theme.border}`,
          background: theme.surface,
        }}
      >
        <a
          href="/"
          style={{
            color: theme.accent,
            textDecoration: "none",
            fontSize: 13,
            fontFamily: theme.mono,
          }}
        >
          ← Sessions
        </a>
        <span
          style={{
            fontSize: 13,
            color: theme.muted,
            fontFamily: theme.mono,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={sessionId}
        >
          {sessionId}
        </span>
        <span style={{ flex: 1 }} />
        {readOnly && (
          <span
            style={{
              fontSize: 12,
              color: theme.warn,
              fontFamily: theme.mono,
            }}
          >
            input disabled — another viewer is driving
          </span>
        )}
        <StatusPill status={status} />
      </header>

      {error ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            color: theme.closed,
            fontFamily: theme.mono,
            padding: 24,
            textAlign: "center",
          }}
        >
          <p style={{ margin: 0 }}>Terminal failed to load</p>
          <p style={{ margin: 0, color: theme.muted, fontSize: 13 }}>{error}</p>
        </div>
      ) : (
        // The WTerm renderer mounts INTO this element (it appends a `.term-grid`
        // child and applies the `.wterm` class + scrollback). It must be able
        // to grow and scroll for the ResizeObserver to compute the grid.
        <div
          ref={hostRef}
          tabIndex={0}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            background: theme.bg,
            // read-only is purely advisory here; the transport is the real gate.
            cursor: readOnly ? "default" : "text",
          }}
        />
      )}
    </div>
  );
}
