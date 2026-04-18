"use client";

/**
 * UsageCell
 *
 * Renders the 5-hour-window usage snapshot for an account.
 *
 * Pre-polled fallback: when the Anthropic usage poller has not yet observed
 * the account the fields arrive as `null`. We render an explicit muted
 * placeholder ("not polled yet") so the operator can distinguish "truly
 * zero usage" from "we don't know yet".
 */

function formatResetsAt(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const now = Date.now();
  const reset = new Date(resetsAt).getTime();
  const diffMs = reset - now;

  if (diffMs <= 0) return "resets now";

  const minutes = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(diffMs / (1000 * 60 * 60));

  if (hours >= 1) {
    const remainderMin = minutes - hours * 60;
    return remainderMin > 0
      ? `resets in ${hours}h ${remainderMin}m`
      : `resets in ${hours}h`;
  }
  if (minutes >= 1) return `resets in ${minutes}m`;
  return "resets in <1m";
}

function usageColor(percent: number): string {
  if (percent >= 90) return "var(--color-error)";
  if (percent >= 75) return "var(--color-warning)";
  return "var(--color-success)";
}

export function UsageCell({
  percent,
  resetsAt,
}: {
  percent: number | null;
  resetsAt: string | null;
}) {
  if (percent === null) {
    return (
      <span
        style={{
          fontSize: "var(--font-size-xs)",
          color: "var(--color-fg-muted)",
          fontStyle: "italic",
        }}
      >
        not polled yet
      </span>
    );
  }

  const rounded = Math.round(percent);
  const color = usageColor(rounded);

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--font-size-xs)",
          fontWeight: "var(--font-weight-medium)",
          color,
          whiteSpace: "nowrap",
        }}
      >
        {rounded}%
      </span>
      {resetsAt && (
        <span
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-fg-dim)",
            whiteSpace: "nowrap",
          }}
          suppressHydrationWarning
        >
          {formatResetsAt(resetsAt)}
        </span>
      )}
    </div>
  );
}
