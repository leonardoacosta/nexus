"use client";

import { useMemo, useState } from "react";

import type { Account, CredentialFile } from "@nexus/core";

import type { Credential } from "@/app/actions/credentials";

import { ActiveBadge } from "./active-badge";
import {
  expiryColor,
  formatExpiry,
  formatRelativeTime,
  parseTier,
} from "./helpers";
import { McpBadges } from "./mcp-badges";
import { PlanBadge } from "./plan-badge";
import { compareSnapshots } from "./account-sort";
import type { SnapshotSortColumn, SnapshotSortState } from "./types";
import { UsageCell } from "./usage-cell";

const TOTAL_COLUMNS = 8;

function SnapshotSortHeader({
  label,
  column,
  current,
  onSort,
}: {
  label: string;
  column: SnapshotSortColumn;
  current: SnapshotSortState;
  onSort: (column: SnapshotSortColumn) => void;
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
        padding: "var(--space-1_5) var(--space-3)",
        textAlign: "left",
        fontSize: "10px",
        fontWeight: "var(--font-weight-medium)",
        color: isActive ? "var(--color-fg)" : "var(--color-fg-muted)",
        textTransform: "uppercase",
        letterSpacing: "var(--tracking-wide)",
        cursor: "pointer",
        userSelect: "none",
        whiteSpace: "nowrap",
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

function SnapshotSubTable({ snapshots }: { snapshots: CredentialFile[] }) {
  const [sort, setSort] = useState<SnapshotSortState>({
    column: null,
    direction: null,
  });

  const handleSort = (column: SnapshotSortColumn) => {
    setSort((prev) => {
      if (prev.column !== column) return { column, direction: "asc" };
      if (prev.direction === "asc") return { column, direction: "desc" };
      return { column: null, direction: null };
    });
  };

  const sorted = useMemo(() => {
    if (!sort.column || !sort.direction) return snapshots;
    const col = sort.column;
    const dir = sort.direction;
    return [...snapshots].sort((a, b) => {
      const cmp = compareSnapshots(a, b, col);
      return dir === "desc" ? -cmp : cmp;
    });
  }, [snapshots, sort.column, sort.direction]);

  return (
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: "var(--font-size-xs)",
        background: "var(--color-bg)",
      }}
    >
      <thead>
        <tr
          style={{
            borderBottom: "1px solid var(--color-border)",
          }}
        >
          <SnapshotSortHeader
            label="Snapshot file"
            column="name"
            current={sort}
            onSort={handleSort}
          />
          <SnapshotSortHeader
            label="Role"
            column="primary"
            current={sort}
            onSort={handleSort}
          />
          <SnapshotSortHeader
            label="First Seen"
            column="firstSeen"
            current={sort}
            onSort={handleSort}
          />
          <SnapshotSortHeader
            label="Token Expiry"
            column="tokenExpiry"
            current={sort}
            onSort={handleSort}
          />
        </tr>
      </thead>
      <tbody>
        {sorted.map((snap) => (
          <tr
            key={snap.id}
            style={{ borderBottom: "1px solid var(--color-border)" }}
          >
            <td
              style={{
                padding: "var(--space-1_5) var(--space-3)",
                fontFamily: "var(--font-mono)",
                color: "var(--color-fg)",
                whiteSpace: "nowrap",
              }}
            >
              {snap.name}
            </td>
            <td
              style={{
                padding: "var(--space-1_5) var(--space-3)",
                color: "var(--color-fg-muted)",
                whiteSpace: "nowrap",
              }}
            >
              {snap.isPrimary ? "primary" : "duplicate"}
              {snap.leasedBy ? ` · leased` : ""}
            </td>
            <td
              style={{
                padding: "var(--space-1_5) var(--space-3)",
                color: "var(--color-fg-dim)",
                whiteSpace: "nowrap",
              }}
              suppressHydrationWarning
            >
              {formatRelativeTime(snap.createdAt)}
            </td>
            <td
              style={{
                padding: "var(--space-1_5) var(--space-3)",
                color: expiryColor(snap.expiresAt),
                whiteSpace: "nowrap",
              }}
              suppressHydrationWarning
            >
              {formatExpiry(snap.expiresAt)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AccountRow({
  account,
  accountLabel,
  mcpProviders,
  resolvedPath,
}: {
  account: Account;
  /** Display label for the primary file — typically the primary credential's
   *  accountEmail falling back to its `name`. Supplied by the parent table. */
  accountLabel: string;
  /** Raw mcp provider string from the primary credential row. */
  mcpProviders: string | null;
  /** Resolved on-disk path from `/credentials/active`; surfaced via tooltip. */
  resolvedPath: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMultipleSnapshots = account.snapshots.length > 1;
  const primary = account.snapshots.find((s) => s.isPrimary) ?? account.snapshots[0]!;

  const toggle = () => {
    if (!hasMultipleSnapshots) return;
    setExpanded((prev) => !prev);
  };

  return (
    <>
      <tr
        style={{
          borderBottom: expanded
            ? "none"
            : "1px solid var(--color-border)",
          transition: "background var(--transition-fast)",
          cursor: hasMultipleSnapshots ? "pointer" : "default",
        }}
        onClick={toggle}
        className="cred-row"
      >
        {/* Expand chevron */}
        <td
          style={{
            padding: "var(--space-2) var(--space-3)",
            width: "24px",
            verticalAlign: "middle",
            color: "var(--color-fg-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-xs)",
            userSelect: "none",
          }}
          aria-hidden="true"
        >
          {hasMultipleSnapshots ? (expanded ? "\u25BE" : "\u25B8") : ""}
        </td>

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
              display: "inline-flex",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <span>{accountLabel}</span>
            {hasMultipleSnapshots && (
              <span
                style={{
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-fg-muted)",
                  marginLeft: "var(--space-1_5)",
                }}
              >
                ({account.snapshots.length} files)
              </span>
            )}
            {account.isActiveForCc && (
              <ActiveBadge resolvedPath={resolvedPath} />
            )}
          </div>
        </td>

        {/* Plan */}
        <td style={{ padding: "var(--space-2) var(--space-3)" }}>
          <PlanBadge subscriptionType={account.plan} />
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
          {parseTier(account.tier)}
        </td>

        {/* Usage */}
        <td style={{ padding: "var(--space-2) var(--space-3)" }}>
          <UsageCell
            percent={account.usagePercent}
            resetsAt={account.resetsAt}
          />
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
          {formatRelativeTime(primary.createdAt)}
        </td>

        {/* Token Expiry */}
        <td
          style={{
            padding: "var(--space-2) var(--space-3)",
            fontSize: "var(--font-size-xs)",
            color: expiryColor(primary.expiresAt),
            whiteSpace: "nowrap",
          }}
          suppressHydrationWarning
        >
          {formatExpiry(primary.expiresAt)}
        </td>

        {/* MCPs */}
        <td
          style={{
            padding: "var(--space-2) var(--space-3)",
            fontSize: "var(--font-size-xs)",
          }}
        >
          <McpBadges providers={mcpProviders} />
        </td>
      </tr>

      {expanded && hasMultipleSnapshots && (
        <tr>
          <td
            colSpan={TOTAL_COLUMNS}
            style={{
              padding: 0,
              background: "var(--color-bg)",
              borderBottom: "1px solid var(--color-border)",
            }}
          >
            <div
              style={{
                padding:
                  "var(--space-2) var(--space-3) var(--space-3) var(--space-6)",
              }}
            >
              <SnapshotSubTable snapshots={account.snapshots} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
