export default function SessionDetailLoading() {
  return (
    <div>
      {/* Top bar skeleton */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          marginBottom: "var(--space-6)",
        }}
      >
        <div
          style={{
            width: 120,
            height: 16,
            borderRadius: "var(--radius-sm)",
            background: "var(--color-surface-raised)",
            animation: "pulse 1.5s ease-in-out infinite",
          }}
        />
        <span style={{ color: "var(--color-fg-ghost)" }}>/</span>
        <div
          style={{
            width: 240,
            height: 16,
            borderRadius: "var(--radius-sm)",
            background: "var(--color-surface-raised)",
            animation: "pulse 1.5s ease-in-out infinite",
          }}
        />
      </div>

      {/* Two-column layout skeleton */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 320px",
          gap: "var(--space-4)",
          minHeight: "calc(100vh - 200px)",
        }}
      >
        {/* Left: Terminal placeholder */}
        <div
          style={{
            minHeight: 400,
            borderRadius: "var(--radius-lg)",
            background: "var(--color-surface-raised)",
            animation: "pulse 1.5s ease-in-out infinite",
          }}
        />

        {/* Right: Metadata sidebar skeleton */}
        <div
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-lg)",
            padding: "var(--space-4)",
            height: "fit-content",
          }}
        >
          {/* Title skeleton */}
          <div
            style={{
              width: 80,
              height: 12,
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface-raised)",
              marginBottom: "var(--space-4)",
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          />

          {/* Metadata row skeletons */}
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i}>
                <div
                  style={{
                    width: 60,
                    height: 10,
                    borderRadius: "var(--radius-sm)",
                    background: "var(--color-surface-raised)",
                    marginBottom: "var(--space-1)",
                    animation: "pulse 1.5s ease-in-out infinite",
                  }}
                />
                <div
                  style={{
                    width: i % 2 === 0 ? 140 : 100,
                    height: 14,
                    borderRadius: "var(--radius-sm)",
                    background: "var(--color-surface-raised)",
                    animation: "pulse 1.5s ease-in-out infinite",
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
