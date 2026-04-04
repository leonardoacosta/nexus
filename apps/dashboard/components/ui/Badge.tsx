import type { ReactNode } from "react";

type BadgeVariant = "default" | "success" | "warning" | "danger";

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}

const VARIANT_STYLES: Record<BadgeVariant, { bg: string; color: string }> = {
  default: {
    bg: "var(--color-surface-raised)",
    color: "var(--color-fg-dim)",
  },
  success: {
    bg: "var(--color-success-ghost)",
    color: "var(--color-success)",
  },
  warning: {
    bg: "var(--color-warning-ghost)",
    color: "var(--color-warning)",
  },
  danger: {
    bg: "var(--color-error-ghost)",
    color: "var(--color-error)",
  },
};

export function Badge({ variant = "default", children, className }: BadgeProps) {
  const styles = VARIANT_STYLES[variant];
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "var(--space-0_5) var(--space-2)",
        fontSize: "var(--font-size-xs)",
        fontWeight: "var(--font-weight-medium)",
        lineHeight: "var(--line-height-tight)",
        borderRadius: "var(--radius-full)",
        background: styles.bg,
        color: styles.color,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}
