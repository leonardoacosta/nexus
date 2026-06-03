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
 * GRID-SIZE SOURCE OF TRUTH (nx-2b9k8): the agent's `geometry` frame is the
 * ONLY authority for the emulator grid. We mount WTerm with `autoResize:false`.
 * Letting WTerm's built-in ResizeObserver run was the garble root cause — it
 * measured the host px, recomputed cols from `floor(width / charWidth)`, and
 * called `term.resize()`. That (a) rebuilt the renderer grid to a DIFFERENT
 * column count than the one the VT engine was positioning against (so CUP
 * escapes + the capture-pane scrollback, both composed for the real pane width,
 * landed in the wrong cells -> overlap / gaps), and (b) fired `onResize` ->
 * `sendResize` -> `tmux resize-window`, permanently shrinking the SHARED pane
 * that the real CC session and other viewers use. A browser/phone client must
 * never drive a shared pane's size. Instead we keep the grid at the agent's
 * exact `cols x rows` and FIT it to the container by shrinking the font size
 * (`--term-font-size` / `--term-row-height`) so every column stays visible and
 * readable at any viewport width — no horizontal scroll, no column-count
 * tug-of-war. Font-shrink (vs a CSS transform) keeps layout/scroll honest: the
 * rows are physically smaller, so `scrollHeight` and `_scrollToBottom` work.
 *
 * FONT-READY BEFORE MEASURE: WTerm measures the monospace cell width/height in
 * its constructor/init to set `--term-row-height`. If the webfont/CSS hasn't
 * settled, the cell metrics are wrong and the fit math is off. We `await
 * document.fonts.ready` before mounting so the measured cell is final.
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
    let fitObserver: ResizeObserver | null = null;
    let fitRaf: number | null = null;

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

    // Current grid column count (agent-driven). Feeds the fit math.
    let gridCols = pending.geometry?.cols ?? 80;

    // The font size at which one cell is exactly `cellWidthAtBase` px wide. We
    // measure this ONCE after font-ready, then derive a fit font-size as a
    // linear scale of the base (monospace cell width is proportional to
    // font-size). `BASE_FONT_PX` matches the `--term-font-size` shipped by
    // `@wterm/dom/css` (14px); `MIN_FONT_PX` keeps glyphs legible on phones.
    const BASE_FONT_PX = 14;
    const MIN_FONT_PX = 6;
    let cellWidthAtBase = 0; // px per cell at BASE_FONT_PX

    /**
     * Measure the rendered monospace cell width at BASE_FONT_PX by probing a
     * 10-char run in a `.term-row` (the same DOM context WTerm renders into).
     * Averaging over 10 chars cancels sub-pixel rounding. The probe forces the
     * base font-size so the result is independent of any fit scaling already
     * applied to the host. Returns 0 if the grid isn't mounted yet.
     */
    const measureCellWidthAtBase = (grid: HTMLElement): number => {
      const probeRow = document.createElement("div");
      probeRow.className = "term-row";
      probeRow.style.cssText = `visibility:hidden;position:absolute;white-space:pre;font-size:${BASE_FONT_PX}px;line-height:normal`;
      const span = document.createElement("span");
      span.textContent = "WWWWWWWWWW"; // 10 cells
      probeRow.appendChild(span);
      grid.appendChild(probeRow);
      const w = span.getBoundingClientRect().width / 10;
      probeRow.remove();
      return w;
    };

    /**
     * Fit the agent-sized `cols x rows` grid into the host width by shrinking
     * the FONT (not a CSS transform). Transform scaling desyncs visual size from
     * layout: the host still reserves the unscaled row heights, so vertical
     * scroll lands in dead space and the live screen clusters at the top. By
     * lowering `--term-font-size` + `--term-row-height` instead, the rows become
     * physically smaller, `scrollHeight` / `_scrollToBottom` stay honest, and
     * every column fits without horizontal scroll. Cols are NEVER recomputed
     * from host px — the agent geometry is the sole authority. Idempotent +
     * rAF-coalesced.
     *
     * Natural width is derived as `cols * cellWidth`, NOT from `scrollWidth`:
     * `.term-grid` has `contain: paint` with `display:block`/`white-space:pre`
     * rows, so glyphs overflow the clamped row box and `scrollWidth` lies.
     */
    const fitGrid = () => {
      fitRaf = null;
      const grid = host.querySelector<HTMLElement>(".term-grid");
      if (!grid) return;
      if (cellWidthAtBase <= 0) cellWidthAtBase = measureCellWidthAtBase(grid);
      if (cellWidthAtBase <= 0 || gridCols <= 0) return;
      // Available content width inside the `.wterm` padding (12px each side).
      const cs = getComputedStyle(host);
      const padX =
        (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const avail = host.clientWidth - padX;
      if (avail <= 0) return;
      const naturalAtBase = gridCols * cellWidthAtBase;
      // Font size that makes `cols` cells exactly fill `avail` (never upscale
      // past the base, never below the legibility floor).
      const fitFont = Math.max(
        MIN_FONT_PX,
        Math.min(BASE_FONT_PX, (BASE_FONT_PX * avail) / naturalAtBase),
      );
      host.style.setProperty("--term-font-size", `${fitFont}px`);
      // Keep the row height locked to the line-box of the fitted font (1.2 line
      // height matches the shipped CSS) so rows neither overlap nor gap.
      const rowH = Math.ceil(fitFont * 1.2);
      host.style.setProperty("--term-row-height", `${rowH}px`);
    };

    const scheduleFit = () => {
      if (fitRaf != null) return;
      fitRaf = requestAnimationFrame(fitGrid);
    };

    const applyGeometry = (cols: number, rows: number) => {
      // Drives core.resize(cols, rows). Must precede the byte flush. This is
      // the ONLY thing that changes the grid's column count.
      gridCols = cols;
      term?.resize(cols, rows);
      scheduleFit();
    };

    const feed = (bytes: Uint8Array) => {
      // Drives core.writeRaw(bytes) and schedules a render. New rows may widen
      // the grid's intrinsic size, so re-fit after paint.
      term?.write(bytes);
      scheduleFit();
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

        // Measure the monospace cell only after the font has settled, else
        // WTerm's cell-size probe (and our fit math) use wrong metrics.
        if (typeof document !== "undefined" && document.fonts?.ready) {
          await document.fonts.ready;
          if (disposed) return;
        }

        const wterm = new WTerm(host, {
          core,
          // Agent's opening geometry frame resizes to the real source pane;
          // this is just the pre-replay grid.
          cols: pending.geometry?.cols ?? 80,
          rows: pending.geometry?.rows ?? 24,
          // The agent geometry is the single source of truth for the grid; the
          // browser fits-to-container by scaling (see fitGrid), and must NEVER
          // resize the shared remote pane. Leaving autoResize on caused the
          // garble (grid-vs-VT column mismatch + shared-pane shrink).
          autoResize: false,
          onData: (data) => {
            // Keystrokes + terminal replies. No-op upstream when read-only.
            if (client && !client.isReadOnly()) client.sendInput(data);
          },
        });
        await wterm.init();
        if (disposed) {
          wterm.destroy();
          return;
        }
        term = wterm;
        ready = true;

        // WTerm's `_lockHeight()` (autoResize:false path) pins the host to
        // `rows * rowHeight` px via an inline height. We want the host to fill
        // its flex parent and SCROLL its content instead, so clear that inline
        // height — the React `flex:1` + `overflow-y:auto` styling governs the
        // viewport and the grid's own (now font-fitted) height drives scroll.
        host.style.height = "";

        // Flush buffered frames: geometry FIRST, then bytes.
        if (pending.geometry) {
          applyGeometry(pending.geometry.cols, pending.geometry.rows);
          pending.geometry = null;
        } else {
          // No geometry yet — fit the pre-replay 80x24 grid for now; the
          // opening geometry frame will re-fit once it lands.
          scheduleFit();
        }
        for (const b of pendingBytes) feed(b);
        pendingBytes.length = 0;

        // Our OWN observer: re-fit (font-size only) when the container resizes.
        // Unlike WTerm's autoResize this never changes the grid column count
        // and never touches the remote pane — it only adjusts the fit font-size.
        fitObserver = new ResizeObserver(() => scheduleFit());
        fitObserver.observe(host);

        wterm.focus();
      } catch (err) {
        if (disposed) return;
        setError(
          err instanceof Error ? err.message : "Failed to load terminal renderer",
        );
      }
    })();

    // 3) Clean teardown: stop the transport, dispose the core/renderer, and
    //    tear down the fit observer + any pending fit frame.
    return () => {
      disposed = true;
      if (fitObserver) {
        fitObserver.disconnect();
        fitObserver = null;
      }
      if (fitRaf != null) {
        cancelAnimationFrame(fitRaf);
        fitRaf = null;
      }
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
            // No horizontal scroll: the grid is scaled to fit the width (see
            // fitGrid). Vertical scroll stays for scrollback history.
            overflowX: "hidden",
            overflowY: "auto",
            background: theme.bg,
            // read-only is purely advisory here; the transport is the real gate.
            cursor: readOnly ? "default" : "text",
          }}
        />
      )}
    </div>
  );
}
