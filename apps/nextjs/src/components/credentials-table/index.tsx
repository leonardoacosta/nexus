"use client";

import { useMemo, useState } from "react";

import type { Credential, CredentialGroup } from "@/app/actions/credentials";

import { CredentialRow } from "./row";
export { AccountsTable } from "./accounts-table";
export type { AccountsTableProps } from "./accounts-table";
import { compareCredentials } from "./sort";
import { SortHeader } from "./sort-header";
import type { SortColumn, SortState } from "./types";

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
          </tr>
        </thead>
        <tbody>
          {sortedCredentials.map((cred) => (
            <CredentialRow key={cred.id} credential={cred} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
