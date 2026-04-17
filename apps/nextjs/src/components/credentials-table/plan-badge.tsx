"use client";

import { formatPlan, planBadgeColor } from "./helpers";

export function PlanBadge({
  subscriptionType,
}: {
  subscriptionType: string | null;
}) {
  const label = formatPlan(subscriptionType);
  if (label === "\u2014")
    return <span style={{ color: "var(--color-fg-muted)" }}>{"\u2014"}</span>;
  const colors = planBadgeColor(subscriptionType);
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: "var(--font-size-xs)",
        fontWeight: "var(--font-weight-medium)",
        color: colors.fg,
        background: colors.bg,
        padding: "var(--space-0_5) var(--space-2)",
        borderRadius: "var(--radius-sm)",
        lineHeight: "var(--line-height-tight)",
      }}
    >
      {label}
    </span>
  );
}
