"use client";

export default function SessionDetailError({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "calc(100vh - 200px)",
        gap: "var(--space-4)",
      }}
    >
      <div
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          padding: "var(--space-6)",
          maxWidth: 480,
          width: "100%",
          textAlign: "center",
        }}
      >
        <h2
          style={{
            fontSize: "var(--font-size-lg)",
            fontWeight: "var(--font-weight-semibold)",
            color: "var(--color-fg)",
            marginBottom: "var(--space-2)",
          }}
        >
          Failed to load session
        </h2>
        <p
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--color-fg-dim)",
            fontFamily: "var(--font-mono)",
            marginBottom: "var(--space-4)",
            wordBreak: "break-all",
          }}
        >
          {error.message}
        </p>
        <button
          onClick={reset}
          style={{
            padding: "var(--space-2) var(--space-4)",
            borderRadius: "var(--radius-md)",
            background: "var(--color-primary)",
            color: "var(--color-primary-fg)",
            border: "none",
            cursor: "pointer",
            fontSize: "var(--font-size-sm)",
            fontWeight: "var(--font-weight-medium)",
          }}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
