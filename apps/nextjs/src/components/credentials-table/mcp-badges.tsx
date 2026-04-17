"use client";

import { mcpBadgeColor, parseMcpProviders } from "./helpers";

export function McpBadges({ providers }: { providers: string | null }) {
  const parsed = parseMcpProviders(providers);
  if (parsed.length === 0) {
    return <span style={{ color: "var(--color-fg-muted)" }}>{"\u2014"}</span>;
  }
  return (
    <span style={{ display: "inline-flex", gap: "3px", flexWrap: "wrap" }}>
      {parsed.map((provider) => {
        const colors = mcpBadgeColor(provider);
        return (
          <span
            key={provider}
            title={provider}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "11px",
              fontWeight: "var(--font-weight-medium)",
              fontFamily: "var(--font-mono)",
              color: colors.fg,
              background: colors.bg,
              padding: "1px 6px",
              borderRadius: "2px",
              lineHeight: 1.3,
              letterSpacing: "0",
            }}
          >
            {provider}
          </span>
        );
      })}
    </span>
  );
}
