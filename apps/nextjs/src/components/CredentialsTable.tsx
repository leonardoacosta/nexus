"use client";

import { useState, useMemo } from "react";

import type { Credential, CredentialGroup } from "@/app/actions/credentials";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortColumn =
  | "account"
  | "plan"
  | "tier"
  | "firstSeen"
  | "tokenExpiry"
  | "mcps"
  | "rateLimits";
type SortDirection = "asc" | "desc";

interface SortState {
  column: SortColumn | null;
  direction: SortDirection | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTier(tier: string | null): string {
  if (!tier) return "\u2014";
  const match = tier.match(/(\d+x)/);
  return match ? match[1]! : tier;
}

function parseTierNumeric(tier: string | null): number {
  if (!tier) return 0;
  const match = tier.match(/(\d+)x/);
  return match ? parseInt(match[1]!, 10) : 0;
}

function formatPlan(sub: string | null): string {
  if (!sub) return "\u2014";
  return sub.charAt(0).toUpperCase() + sub.slice(1);
}

function planBadgeColor(sub: string | null): { bg: string; fg: string } {
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
function formatRelativeTime(dateStr: string | null): string {
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
function formatExpiry(expiresAt: string | null): string {
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
function expiryColor(expiresAt: string | null): string {
  if (!expiresAt) return "var(--color-fg-dim)";
  const now = Date.now();
  const expires = new Date(expiresAt).getTime();
  const diffMs = expires - now;

  if (diffMs <= 0) return "var(--color-error)";
  if (diffMs < 24 * 60 * 60 * 1000) return "var(--color-warning)";
  return "var(--color-success)";
}

/** Parse MCP providers from comma-separated string. */
function parseMcpProviders(providers: string | null): string[] {
  if (!providers) return [];
  return providers.split(",").filter((p) => p.length > 0);
}

/** Get display label for an MCP provider. */
function mcpLabel(provider: string): string {
  switch (provider.toLowerCase()) {
    case "posthog":
      return "P";
    case "figma":
      return "F";
    case "slack":
      return "S";
    case "stripe":
      return "St";
    case "miro":
      return "M";
    default:
      return provider.charAt(0).toUpperCase();
  }
}

/** Get badge color for an MCP provider. */
function mcpBadgeColor(provider: string): { bg: string; fg: string } {
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

// ---------------------------------------------------------------------------
// Sort logic
// ---------------------------------------------------------------------------

function getExpiryTimestamp(expiresAt: string | null): number {
  if (!expiresAt) return Infinity;
  return new Date(expiresAt).getTime();
}

function compareCredentials(
  a: Credential,
  b: Credential,
  column: SortColumn,
): number {
  switch (column) {
    case "account": {
      const aVal = (a.accountEmail ?? a.name).toLowerCase();
      const bVal = (b.accountEmail ?? b.name).toLowerCase();
      return aVal.localeCompare(bVal);
    }
    case "plan": {
      const aVal = formatPlan(a.subscriptionType).toLowerCase();
      const bVal = formatPlan(b.subscriptionType).toLowerCase();
      return aVal.localeCompare(bVal);
    }
    case "tier": {
      return parseTierNumeric(a.rateLimitTier) - parseTierNumeric(b.rateLimitTier);
    }
    case "firstSeen": {
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    }
    case "tokenExpiry": {
      return getExpiryTimestamp(a.expiresAt) - getExpiryTimestamp(b.expiresAt);
    }
    case "mcps": {
      return (
        parseMcpProviders(a.mcpProviders).length -
        parseMcpProviders(b.mcpProviders).length
      );
    }
    case "rateLimits": {
      return a.rateLimitCount - b.rateLimitCount;
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SortHeader({
  label,
  column,
  current,
  onSort,
  align,
}: {
  label: string;
  column: SortColumn;
  current: SortState;
  onSort: (column: SortColumn) => void;
  align?: "left" | "right";
}) {
  const isActive = current.column === column;
  const indicator = isActive
    ? current.direction === "asc"
      ? "\u25B2"
      : "\u25BC"
    : "\u21C5";

  return (
    <th
      onClick={() => onSort(column)}
      style={{
        padding: "var(--space-2) var(--space-3)",
        textAlign: align ?? "left",
        fontSize: "var(--font-size-xs)",
        fontWeight: "var(--font-weight-medium)",
        color: isActive ? "var(--color-fg)" : "var(--color-fg-muted)",
        textTransform: "uppercase",
        letterSpacing: "var(--tracking-wide)",
        whiteSpace: "nowrap",
        cursor: "pointer",
        userSelect: "none",
        transition: "color var(--transition-fast)",
      }}
    >
      {label}
      <span
        style={{
          marginLeft: 4,
          opacity: isActive ? 1 : 0.3,
          fontSize: "0.75em",
          fontFamily: "var(--font-mono)",
        }}
      >
        {indicator}
      </span>
    </th>
  );
}

function PlanBadge({ subscriptionType }: { subscriptionType: string | null }) {
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

function McpBadges({ providers }: { providers: string | null }) {
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
              fontSize: "10px",
              fontWeight: "var(--font-weight-medium)",
              fontFamily: "var(--font-mono)",
              color: colors.fg,
              background: colors.bg,
              padding: "1px 4px",
              borderRadius: "2px",
              lineHeight: 1.3,
              letterSpacing: "0",
            }}
          >
            {mcpLabel(provider)}
          </span>
        );
      })}
    </span>
  );
}

function CredentialRow({
  credential,
}: {
  credential: Credential;
}) {
  const duplicateCount = credential.duplicates?.length ?? 0;

  return (
    <tr
      style={{
        borderBottom: "1px solid var(--color-border)",
        transition: "background var(--transition-fast)",
      }}
      className="cred-row"
    >
      {/* Account */}
      <td
        style={{
          padding: "var(--space-2) var(--space-3)",
          whiteSpace: "nowrap",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-sm)",
            color: "var(--color-fg)",
            lineHeight: "var(--line-height-tight)",
          }}
        >
          {credential.accountEmail ?? credential.name}
          {duplicateCount > 0 && (
            <span
              style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--color-fg-muted)",
                marginLeft: "var(--space-1_5)",
              }}
            >
              (+{duplicateCount})
            </span>
          )}
        </div>
        {credential.orgName && (
          <div
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-fg-muted)",
              lineHeight: "var(--line-height-tight)",
              marginTop: "1px",
            }}
          >
            {credential.orgName}
          </div>
        )}
      </td>

      {/* Plan */}
      <td style={{ padding: "var(--space-2) var(--space-3)" }}>
        <PlanBadge subscriptionType={credential.subscriptionType} />
      </td>

      {/* Tier */}
      <td
        style={{
          padding: "var(--space-2) var(--space-3)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--font-size-xs)",
          color: "var(--color-fg-dim)",
          whiteSpace: "nowrap",
        }}
      >
        {parseTier(credential.rateLimitTier)}
      </td>

      {/* First Seen */}
      <td
        style={{
          padding: "var(--space-2) var(--space-3)",
          fontSize: "var(--font-size-xs)",
          color: "var(--color-fg-dim)",
          whiteSpace: "nowrap",
        }}
        suppressHydrationWarning
      >
        {formatRelativeTime(credential.createdAt)}
      </td>

      {/* Token Expiry */}
      <td
        style={{
          padding: "var(--space-2) var(--space-3)",
          fontSize: "var(--font-size-xs)",
          color: expiryColor(credential.expiresAt),
          whiteSpace: "nowrap",
        }}
        suppressHydrationWarning
      >
        {formatExpiry(credential.expiresAt)}
      </td>

      {/* MCPs */}
      <td
        style={{
          padding: "var(--space-2) var(--space-3)",
          fontSize: "var(--font-size-xs)",
        }}
      >
        <McpBadges providers={credential.mcpProviders} />
      </td>

      {/* Rate Limits */}
      <td
        style={{
          padding: "var(--space-2) var(--space-3)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--font-size-xs)",
          color:
            credential.rateLimitCount > 0
              ? "var(--color-warning)"
              : "var(--color-fg-dim)",
          textAlign: "right",
        }}
      >
        {credential.rateLimitCount}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CredentialsTable({
  credentials,
}: {
  credentials: Credential[];
  credGroupMap: Record<string, CredentialGroup>;
}) {
  const [sort, setSort] = useState<SortState>({
    column: null,
    direction: null,
  });

  const handleSort = (column: SortColumn) => {
    setSort((prev) => {
      if (prev.column !== column) {
        return { column, direction: "asc" };
      }
      if (prev.direction === "asc") {
        return { column, direction: "desc" };
      }
      return { column: null, direction: null };
    });
  };

  const sortedCredentials = useMemo(() => {
    if (!sort.column || !sort.direction) return credentials;

    const col = sort.column;
    const dir = sort.direction;

    return [...credentials].sort((a, b) => {
      const cmp = compareCredentials(a, b, col);
      return dir === "desc" ? -cmp : cmp;
    });
  }, [credentials, sort.column, sort.direction]);

  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
      }}
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "var(--font-size-sm)",
        }}
      >
        <thead>
          <tr
            style={{
              borderBottom: "1px solid var(--color-border)",
              background: "var(--color-surface-raised)",
            }}
          >
            <SortHeader
              label="Account"
              column="account"
              current={sort}
              onSort={handleSort}
            />
            <SortHeader
              label="Plan"
              column="plan"
              current={sort}
              onSort={handleSort}
            />
            <SortHeader
              label="Tier"
              column="tier"
              current={sort}
              onSort={handleSort}
            />
            <SortHeader
              label="First Seen"
              column="firstSeen"
              current={sort}
              onSort={handleSort}
            />
            <SortHeader
              label="Token Expiry"
              column="tokenExpiry"
              current={sort}
              onSort={handleSort}
            />
            <SortHeader
              label="MCPs"
              column="mcps"
              current={sort}
              onSort={handleSort}
            />
            <SortHeader
              label="Rate Limits"
              column="rateLimits"
              current={sort}
              onSort={handleSort}
              align="right"
            />
          </tr>
        </thead>
        <tbody>
          {sortedCredentials.map((cred) => (
            <CredentialRow
              key={cred.id}
              credential={cred}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
