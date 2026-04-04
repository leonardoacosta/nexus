type StatusDotStatus = "active" | "idle" | "ended";

interface StatusDotProps {
  status: StatusDotStatus;
  className?: string;
}

const STATUS_COLORS: Record<StatusDotStatus, string> = {
  active: "var(--color-success)",
  idle: "var(--color-warning)",
  ended: "var(--color-fg-ghost)",
};

export function StatusDot({ status, className }: StatusDotProps) {
  return (
    <span
      className={className}
      role="status"
      aria-label={status}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "var(--radius-full)",
        background: STATUS_COLORS[status],
        flexShrink: 0,
      }}
    />
  );
}
