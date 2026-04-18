"use client";

import { useMemo, useState } from "react";

import type { Account } from "@nexus/core";

import type { Credential } from "@/app/actions/credentials";

import { AccountRow } from "./account-row";
import {
  compareAccounts,
  mcpCountForAccount,
} from "./account-sort";
import { SortHeader } from "./sort-header";
import type { SortColumn, SortState } from "./types";

export interface AccountsTableProps {
  accounts: Account[];
  /** Flat credential rows keyed by id — used to enrich accounts with
   *  email labels and mcp provider strings that don't live on `Account`. */
  credentials: Credential[];
  /**
   * Active credential resolved-path surfaced by the agent watcher; passed
   * through to the `ActiveBadge` tooltip. May be null when no active
   * credential has been observed yet.
   */
  resolvedPath: string | null;
}

export function AccountsTable({
  accounts,
  credentials,
  resolvedPath,
}: AccountsTableProps) {
  const credentialsById = useMemo(() => {
    const map = new Map<string, Credential>();
    for (const cred of credentials) map.set(cred.id, cred);
    return map;
  }, [credentials]);

  // Per-account label: prefer accountEmail of primary snapshot, fall back
  // to its `name`. Also keep its org + mcp providers for the row to read.
  const accountMeta = useMemo(() => {
    const labels = new Map<string, string>();
    const orgs = new Map<string, string | null>();
    const mcp = new Map<string, string | null>();
    for (const acct of accounts) {
      const primary =
        acct.snapshots.find((s) => s.isPrimary) ?? acct.snapshots[0];
      if (!primary) continue;
      const cred = credentialsById.get(primary.id);
      const label = cred?.accountEmail ?? cred?.name ?? primary.name;
      labels.set(acct.fingerprint, label);
      orgs.set(acct.fingerprint, cred?.orgName ?? null);
      mcp.set(acct.fingerprint, cred?.mcpProviders ?? null);
    }
    return { labels, orgs, mcp };
  }, [accounts, credentialsById]);

  const [sort, setSort] = useState<SortState>({
    column: null,
    direction: null,
  });

  const handleSort = (column: SortColumn) => {
    setSort((prev) => {
      if (prev.column !== column) return { column, direction: "asc" };
      if (prev.direction === "asc") return { column, direction: "desc" };
      return { column: null, direction: null };
    });
  };

  const sortedAccounts = useMemo(() => {
    if (!sort.column || !sort.direction) return accounts;
    const col = sort.column;
    const dir = sort.direction;
    return [...accounts].sort((a, b) => {
      let cmp: number;
      if (col === "mcps") {
        cmp =
          mcpCountForAccount(a, credentialsById) -
          mcpCountForAccount(b, credentialsById);
      } else {
        cmp = compareAccounts(a, b, col, accountMeta.labels);
      }
      return dir === "desc" ? -cmp : cmp;
    });
  }, [accounts, sort.column, sort.direction, accountMeta.labels, credentialsById]);

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
            {/* Chevron column — no sort */}
            <th
              style={{
                width: "24px",
                padding: "var(--space-2) var(--space-3)",
              }}
              aria-hidden="true"
            />
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
              label="Usage (5h)"
              column="usage"
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
          </tr>
        </thead>
        <tbody>
          {sortedAccounts.map((account) => {
            const label =
              accountMeta.labels.get(account.fingerprint) ??
              account.fingerprint.slice(0, 12);
            const mcp = accountMeta.mcp.get(account.fingerprint) ?? null;
            return (
              <AccountRow
                key={account.fingerprint}
                account={account}
                accountLabel={label}
                mcpProviders={mcp}
                resolvedPath={
                  account.isActiveForCc ? resolvedPath : null
                }
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
