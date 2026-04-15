"use client";

import { useState, useMemo } from "react";

import type { Credential, CredentialGroup } from "@/app/actions/credentials";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortColumn = "account" | "plan" | "tier" | "status" | "rateLimits" | "expires";
type SortDirection = "asc" | "desc";

interface SortState {
  column: SortColumn | null;
  direction: SortDirection | null;
}

// ---------------------------------------------------------------------------
// Helpers (duplicated from page — pure formatting, no server deps)
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function parseTier(tier: string | null): string {
  if (!tier) return "—";
  const match = tier.match(/(\d+x)/);
  return match ? match[1]! : tier;
}

function parseTierNumeric(tier: string | null): number {
  if (!tier) return 0;
  const match = tier.match(/(\d+)x/);
  return match ? parseInt(match[1]!, 10) : 0;
}

function formatPlan(sub: string | null): string {
  if (!sub) return "—";
  return sub.charAt(0).toUpperCase() + sub.slice(1);
}

function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return "—";
  const now = Date.now();
  const expires = new Date(expiresAt).getTime();
  const diffMs = expires - now;
  if (diffMs <= 0) return "expired";
  const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (days === 1) return "1d";
  return `${days}d`;
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

function statusColor(status: string): string {
  switch (status) {
    case "available":
      return "var(--color-success)";
    case "rate_limited":
      return "var(--color-warning)";
    case "expired":
      return "var(--color-error)";
    default:
      return "var(--color-fg-dim)";
  }
}

// ---------------------------------------------------------------------------
// Sort logic
// ---------------------------------------------------------------------------

function getExpiryTimestamp(expiresAt: string | null): number {
  if (!expiresAt) return Infinity; // no expiry sorts last
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
    case "status": {
      return a.status.localeCompare(b.status);
    }
    case "rateLimits": {
      return a.rateLimitCount - b.rateLimitCount;
    }
    case "expires": {
      return getExpiryTimestamp(a.expiresAt) - getExpiryTimestamp(b.expiresAt);
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
  if (label === "—")
    return <span style={{ color: "var(--color-fg-muted)" }}>—</span>;
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

function StatusDot({ status }: { status: string }) {
  const color = statusColor(status);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1_5)",
        fontSize: "var(--font-size-xs)",
        color,
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: "6px",
          height: "6px",
          borderRadius: "var(--radius-full)",
          background: color,
        }}
      />
      {status}
    </span>
  );
}

function UsageCell({ group }: { group: CredentialGroup }) {
  if (!group.usage) {
    return <span style={{ color: "var(--color-fg-muted)" }}>—</span>;
  }
  const { input, output } = group.usage;
  if (!input && !output) {
    return <span style={{ color: "var(--color-fg-muted)" }}>—</span>;
  }
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--font-size-xs)",
      }}
    >
      {formatNumber(input)} in / {formatNumber(output)} out
    </span>
  );
}

function CredentialRow({
  credential,
  group,
}: {
  credential: Credential;
  group: CredentialGroup;
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

      {/* Status */}
      <td style={{ padding: "var(--space-2) var(--space-3)" }}>
        <StatusDot status={credential.status} />
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

      {/* Expires */}
      <td
        style={{
          padding: "var(--space-2) var(--space-3)",
          fontSize: "var(--font-size-xs)",
          color:
            formatExpiry(credential.expiresAt) === "expired"
              ? "var(--color-error)"
              : "var(--color-fg-dim)",
          whiteSpace: "nowrap",
        }}
        suppressHydrationWarning
      >
        {formatExpiry(credential.expiresAt)}
      </td>

      {/* Usage */}
      <td
        style={{
          padding: "var(--space-2) var(--space-3)",
          fontSize: "var(--font-size-xs)",
          color: "var(--color-fg-dim)",
          whiteSpace: "nowrap",
        }}
      >
        <UsageCell group={group} />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CredentialsTable({
  credentials,
  credGroupMap,
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
      // desc -> reset
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
              label="Status"
              column="status"
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
            <SortHeader
              label="Expires"
              column="expires"
              current={sort}
              onSort={handleSort}
            />
            {/* Usage — not sortable */}
            <th
              style={{
                padding: "var(--space-2) var(--space-3)",
                textAlign: "left",
                fontSize: "var(--font-size-xs)",
                fontWeight: "var(--font-weight-medium)",
                color: "var(--color-fg-muted)",
                textTransform: "uppercase",
                letterSpacing: "var(--tracking-wide)",
                whiteSpace: "nowrap",
              }}
            >
              Usage (24h)
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedCredentials.map((cred) => (
            <CredentialRow
              key={cred.id}
              credential={cred}
              group={credGroupMap[cred.id]!}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
