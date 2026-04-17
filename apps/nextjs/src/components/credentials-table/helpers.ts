// ---------------------------------------------------------------------------
// Formatting + color helpers for the credentials table.
// ---------------------------------------------------------------------------

export function parseTier(tier: string | null): string {
  if (!tier) return "\u2014";
  const match = tier.match(/(\d+x)/);
  return match ? match[1]! : tier;
}

export function parseTierNumeric(tier: string | null): number {
  if (!tier) return 0;
  const match = tier.match(/(\d+)x/);
  return match ? parseInt(match[1]!, 10) : 0;
}

export function formatPlan(sub: string | null): string {
  if (!sub) return "\u2014";
  return sub.charAt(0).toUpperCase() + sub.slice(1);
}

export function planBadgeColor(sub: string | null): { bg: string; fg: string } {
  switch (sub?.toLowerCase()) {
    case "max":
      return { bg: "var(--color-success-ghost)", fg: "var(--color-success)" };
    case "team":
      return { bg: "var(--color-info-ghost)", fg: "var(--color-info)" };
    case "pro":
      return { bg: "rgba(168, 85, 247, 0.12)", fg: "#A855F7" };
    default:
      return {
        bg: "var(--color-surface-raised)",
        fg: "var(--color-fg-muted)",
      };
  }
}

/** Format a date string as relative time (e.g. "14d ago", "2h ago"). */
export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "\u2014";
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diffMs = now - date;
  const absDiff = Math.abs(diffMs);

  const minutes = Math.floor(absDiff / (1000 * 60));
  const hours = Math.floor(absDiff / (1000 * 60 * 60));
  const days = Math.floor(absDiff / (1000 * 60 * 60 * 24));

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

/** Format token expiry as relative time with direction. */
export function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return "\u2014";
  const now = Date.now();
  const expires = new Date(expiresAt).getTime();
  const diffMs = expires - now;

  if (diffMs <= 0) {
    // Expired
    const absDiff = Math.abs(diffMs);
    const hours = Math.floor(absDiff / (1000 * 60 * 60));
    const days = Math.floor(absDiff / (1000 * 60 * 60 * 24));
    if (days > 0) return `expired ${days}d ago`;
    if (hours > 0) return `expired ${hours}h ago`;
    return "expired";
  }

  // Not expired
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days > 0) return `in ${days}d`;
  if (hours > 0) return `in ${hours}h`;
  return `in <1h`;
}

/** Get color for token expiry based on time remaining. */
export function expiryColor(expiresAt: string | null): string {
  if (!expiresAt) return "var(--color-fg-dim)";
  const now = Date.now();
  const expires = new Date(expiresAt).getTime();
  const diffMs = expires - now;

  if (diffMs <= 0) return "var(--color-error)";
  if (diffMs < 24 * 60 * 60 * 1000) return "var(--color-warning)";
  return "var(--color-success)";
}

/** Parse MCP providers from comma-separated string. */
export function parseMcpProviders(providers: string | null): string[] {
  if (!providers) return [];
  return providers.split(",").filter((p) => p.length > 0);
}

/** Get badge color for an MCP provider. */
export function mcpBadgeColor(provider: string): { bg: string; fg: string } {
  switch (provider.toLowerCase()) {
    case "posthog":
      return { bg: "rgba(59, 130, 246, 0.15)", fg: "#3B82F6" };
    case "figma":
      return { bg: "rgba(168, 85, 247, 0.15)", fg: "#A855F7" };
    case "slack":
      return { bg: "rgba(34, 197, 94, 0.15)", fg: "#22C55E" };
    case "stripe":
      return { bg: "rgba(99, 102, 241, 0.15)", fg: "#6366F1" };
    case "miro":
      return { bg: "rgba(249, 115, 22, 0.15)", fg: "#F97316" };
    default:
      return { bg: "var(--color-surface-raised)", fg: "var(--color-fg-muted)" };
  }
}
