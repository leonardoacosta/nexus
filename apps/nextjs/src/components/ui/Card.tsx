import type { ReactNode, CSSProperties } from "react";

interface CardProps {
  title?: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Card({ title, children, className, style }: CardProps) {
  return (
    <div
      className={className}
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-4)",
        ...style,
      }}
    >
      {title && (
        <h3
          style={{
            fontSize: "var(--font-size-sm)",
            fontWeight: "var(--font-weight-medium)",
            color: "var(--color-fg-dim)",
            marginBottom: "var(--space-3)",
            letterSpacing: "var(--tracking-wide)",
            textTransform: "uppercase" as const,
          }}
        >
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={className}
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-4)",
      }}
    >
      <div
        style={{
          height: 12,
          width: "40%",
          background: "var(--color-surface-raised)",
          borderRadius: "var(--radius-sm)",
          marginBottom: "var(--space-3)",
          animation: "pulse 1.5s ease-in-out infinite",
        }}
      />
      <div
        style={{
          height: 16,
          width: "80%",
          background: "var(--color-surface-raised)",
          borderRadius: "var(--radius-sm)",
          animation: "pulse 1.5s ease-in-out infinite",
        }}
      />
    </div>
  );
}
