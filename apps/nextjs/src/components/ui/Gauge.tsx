interface GaugeProps {
  /** Value from 0 to 100 */
  value: number;
  /** Optional label shown to the left */
  label?: string;
  className?: string;
}

function getGaugeColor(value: number): string {
  if (value > 95) return "var(--color-error)";
  if (value >= 80) return "var(--color-warning)";
  return "var(--color-success)";
}

export function Gauge({ value, label, className }: GaugeProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const color = getGaugeColor(clamped);

  return (
    <div
      className={className}
      style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
    >
      {label && (
        <span
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-fg-muted)",
            minWidth: 32,
          }}
        >
          {label}
        </span>
      )}
      <div
        style={{
          flex: 1,
          height: 6,
          background: "var(--color-surface-raised)",
          borderRadius: "var(--radius-full)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${clamped}%`,
            height: "100%",
            background: color,
            borderRadius: "var(--radius-full)",
            transition: "width var(--transition-base)",
          }}
        />
      </div>
      <span
        style={{
          fontSize: "var(--font-size-xs)",
          color: "var(--color-fg-dim)",
          fontFamily: "var(--font-mono)",
          minWidth: 36,
          textAlign: "right",
        }}
      >
        {clamped}%
      </span>
    </div>
  );
}

export function GaugeSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={className}
      style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
    >
      <div
        style={{
          flex: 1,
          height: 6,
          background: "var(--color-surface-raised)",
          borderRadius: "var(--radius-full)",
          animation: "pulse 1.5s ease-in-out infinite",
        }}
      />
      <span
        style={{
          width: 36,
          height: 12,
          background: "var(--color-surface-raised)",
          borderRadius: "var(--radius-sm)",
          animation: "pulse 1.5s ease-in-out infinite",
          display: "inline-block",
        }}
      />
    </div>
  );
}
