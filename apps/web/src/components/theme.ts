/**
 * Nexus dashboard theme tokens for the web app.
 *
 * This app has no Tailwind/`@nexus/ui` package — the existing `layout.tsx` and
 * `page.tsx` style with inline `style={{}}` against the Nexus palette
 * (`#0b0e14` background, `#c5c8c6` foreground, monospace). These tokens are the
 * single source for those values so the chrome, status pills, and pages stay
 * consistent without re-typing hex codes at every call site.
 */
export const theme = {
  /** Page / app background (matches layout body). */
  bg: "#0b0e14",
  /** Slightly raised surface for cards / panels. */
  surface: "#11151f",
  /** Hairline borders. */
  border: "#1c2230",
  /** Primary foreground text. */
  fg: "#c5c8c6",
  /** Muted/secondary text. */
  muted: "#7c8493",
  /** Accent (links, primary action). */
  accent: "#7aa2f7",
  /** Live / healthy. */
  live: "#9ece6a",
  /** Read-only / caution. */
  warn: "#e0af68",
  /** Connecting / pending. */
  pending: "#7dcfff",
  /** Closed / error / destructive. */
  closed: "#f7768e",
  /** Monospace stack used across the dashboard. */
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/** Map a connection status to a display color + label. */
export const STATUS_META: Record<
  "connecting" | "live" | "read-only" | "closed",
  { color: string; label: string }
> = {
  connecting: { color: theme.pending, label: "Connecting" },
  live: { color: theme.live, label: "Live" },
  "read-only": { color: theme.warn, label: "Read-only" },
  closed: { color: theme.closed, label: "Closed" },
};
