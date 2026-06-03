"use client";

import { useCallback, useMemo, useRef, useState } from "react";

/**
 * Pinch-zoom + pan interaction for a single transformed child (the terminal
 * pane). Renderer-agnostic — it knows nothing about WTerm; it only produces a
 * `{ scale, tx, ty }` transform that the caller applies via CSS
 * `transform: translate(tx,ty) scale(scale)` with `transform-origin: 0 0`.
 *
 * Why a manual gesture layer (not the browser's native pinch):
 *   - The default fit-width render shrinks the FONT so the whole pane fits the
 *     phone width (nx-2b9k8). On a wide pane that font can hit the legibility
 *     floor (~8px). Native page pinch-zoom would zoom the WHOLE page (chrome
 *     included) and fight the layout; we want to zoom ONLY the terminal pane and
 *     pan within it while the header/toolbar stay put.
 *   - A CSS transform on a wrapper is purely visual: it never changes the grid
 *     column count or the agent geometry, so the "agent geometry is the sole
 *     grid authority" invariant survives. `.wterm`'s own scroll math (which
 *     reads the untransformed element) also stays honest.
 *
 * Touch: two-finger pinch scales about the gesture centroid; one- or two-finger
 * drag pans. Trackpad/mouse: ctrl/⌘ + wheel (the standard pinch gesture browsers
 * synthesize) zooms about the pointer; plain wheel is left to the terminal's own
 * vertical scrollback.
 */

export interface ZoomTransform {
  scale: number;
  tx: number;
  ty: number;
}

const MIN_SCALE = 1;
const MAX_SCALE = 6;

const IDENTITY: ZoomTransform = { scale: 1, tx: 0, ty: 0 };

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

interface TouchPoint {
  x: number;
  y: number;
}

function midpoint(a: TouchPoint, b: TouchPoint): TouchPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface UsePinchZoomPan {
  /** Current visual transform. Identity (scale 1) means "fit-width default". */
  transform: ZoomTransform;
  /** True whenever the pane is zoomed past the fit-width baseline. */
  zoomed: boolean;
  /** Handlers to spread onto the gesture surface (the transform wrapper's parent). */
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
    onWheel: (e: React.WheelEvent) => void;
  };
  /** Reset to fit-width (scale 1, no pan). */
  reset: () => void;
  /** Step zoom in/out about the surface centre (toolbar buttons). */
  zoomBy: (factor: number) => void;
}

export function usePinchZoomPan(): UsePinchZoomPan {
  const [transform, setTransform] = useState<ZoomTransform>(IDENTITY);

  // Gesture bookkeeping kept in refs so rapid touchmove events don't thrash
  // React state for anything but the committed transform.
  const gesture = useRef<{
    mode: "none" | "pan" | "pinch";
    startDist: number;
    startScale: number;
    // Anchor in CONTENT space (pre-transform) that must stay under the centroid
    // for the zoom to feel anchored to the fingers.
    anchorContentX: number;
    anchorContentY: number;
    // Last centroid in client space, for incremental pan.
    lastClientX: number;
    lastClientY: number;
  }>({
    mode: "none",
    startDist: 0,
    startScale: 1,
    anchorContentX: 0,
    anchorContentY: 0,
    lastClientX: 0,
    lastClientY: 0,
  });

  // The surface element, captured on first touch, used to convert client coords
  // into surface-local coords (so anchoring is relative to the pane, not page).
  const surfaceRef = useRef<HTMLElement | null>(null);

  const localPoint = useCallback(
    (clientX: number, clientY: number): TouchPoint => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      return {
        x: clientX - (rect?.left ?? 0),
        y: clientY - (rect?.top ?? 0),
      };
    },
    [],
  );

  /**
   * Zoom the committed transform about a surface-local anchor, keeping the
   * content cell under the anchor fixed (so wheel + toolbar buttons feel
   * anchored). `nextScaleOf` derives the target scale from the latest committed
   * scale inside the state updater (avoids stale closures). Shared by wheel +
   * `zoomBy`; pinch-move computes its own translate against the live centroid.
   */
  const zoomAbout = useCallback(
    (nextScaleOf: (prev: ZoomTransform) => number, anchor: TouchPoint) => {
      setTransform((prev) => {
        const nextScale = clampScale(nextScaleOf(prev));
        if (nextScale === prev.scale) return prev;
        if (nextScale === 1) return IDENTITY; // snap to fit-width origin
        // Content coord under the anchor: content = (anchor - translate) / scale
        const contentX = (anchor.x - prev.tx) / prev.scale;
        const contentY = (anchor.y - prev.ty) / prev.scale;
        // Solve new translate so the same content stays under the anchor.
        return {
          scale: nextScale,
          tx: anchor.x - contentX * nextScale,
          ty: anchor.y - contentY * nextScale,
        };
      });
    },
    [],
  );

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      surfaceRef.current = e.currentTarget as HTMLElement;
      const g = gesture.current;
      if (e.touches.length === 2) {
        const a = localPoint(e.touches[0].clientX, e.touches[0].clientY);
        const b = localPoint(e.touches[1].clientX, e.touches[1].clientY);
        const mid = midpoint(a, b);
        g.mode = "pinch";
        g.startDist = distance(a, b) || 1;
        setTransform((prev) => {
          g.startScale = prev.scale;
          g.anchorContentX = (mid.x - prev.tx) / prev.scale;
          g.anchorContentY = (mid.y - prev.ty) / prev.scale;
          return prev;
        });
        g.lastClientX = mid.x;
        g.lastClientY = mid.y;
      } else if (e.touches.length === 1) {
        // Single-finger drag pans ONLY when zoomed; at fit-width baseline we
        // leave the touch to the terminal's native vertical scrollback so
        // reading history feels normal.
        const p = localPoint(e.touches[0].clientX, e.touches[0].clientY);
        g.mode = "pan";
        g.lastClientX = p.x;
        g.lastClientY = p.y;
      }
    },
    [localPoint],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const g = gesture.current;
      if (g.mode === "pinch" && e.touches.length === 2) {
        e.preventDefault();
        const a = localPoint(e.touches[0].clientX, e.touches[0].clientY);
        const b = localPoint(e.touches[1].clientX, e.touches[1].clientY);
        const mid = midpoint(a, b);
        const dist = distance(a, b) || 1;
        const nextScale = clampScale((dist / g.startDist) * g.startScale);
        // Keep the content point captured at touchstart pinned under the live
        // centroid (which can itself drift as the fingers move), so the pane
        // tracks the fingers for both scaling AND two-finger panning.
        setTransform(() => {
          if (nextScale === 1) return { scale: 1, tx: 0, ty: 0 };
          return {
            scale: nextScale,
            tx: mid.x - g.anchorContentX * nextScale,
            ty: mid.y - g.anchorContentY * nextScale,
          };
        });
      } else if (g.mode === "pan" && e.touches.length === 1) {
        const p = localPoint(e.touches[0].clientX, e.touches[0].clientY);
        const dx = p.x - g.lastClientX;
        const dy = p.y - g.lastClientY;
        g.lastClientX = p.x;
        g.lastClientY = p.y;
        // Only intercept the pan (and block native scroll) when zoomed; at
        // baseline let the terminal scroll vertically as usual.
        setTransform((prev) => {
          if (prev.scale <= 1) return prev;
          e.preventDefault();
          return { ...prev, tx: prev.tx + dx, ty: prev.ty + dy };
        });
      }
    },
    [localPoint],
  );

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    const g = gesture.current;
    if (e.touches.length === 0) {
      g.mode = "none";
    } else if (e.touches.length === 1) {
      // Transition pinch -> pan smoothly using the remaining finger.
      const t = e.touches[0];
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      g.mode = "pan";
      g.lastClientX = t.clientX - rect.left;
      g.lastClientY = t.clientY - rect.top;
    }
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      // Browsers synthesize ctrl/⌘ + wheel for a trackpad pinch. Only THAT zooms
      // the pane; a plain wheel stays with the terminal's vertical scrollback.
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      surfaceRef.current = e.currentTarget as HTMLElement;
      const anchor = localPoint(e.clientX, e.clientY);
      // Smooth exponential zoom; deltaY<0 (scroll up / pinch out) zooms in.
      zoomAbout((prev) => prev.scale * Math.exp(-e.deltaY * 0.002), anchor);
    },
    [localPoint, zoomAbout],
  );

  const reset = useCallback(() => setTransform(IDENTITY), []);

  const zoomBy = useCallback(
    (factor: number) => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      const anchor: TouchPoint = rect
        ? { x: rect.width / 2, y: rect.height / 2 }
        : { x: 0, y: 0 };
      zoomAbout((prev) => prev.scale * factor, anchor);
    },
    [zoomAbout],
  );

  const handlers = useMemo(
    () => ({ onTouchStart, onTouchMove, onTouchEnd, onWheel }),
    [onTouchStart, onTouchMove, onTouchEnd, onWheel],
  );

  return {
    transform,
    zoomed: transform.scale > 1.001,
    handlers,
    reset,
    zoomBy,
  } satisfies UsePinchZoomPan;
}
