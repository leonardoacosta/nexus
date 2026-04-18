import type { Account, CredentialFile } from "@nexus/core";

import type {
  SnapshotSortColumn,
  SortColumn,
} from "./types";
import { formatPlan, parseMcpProviders, parseTierNumeric } from "./helpers";
import type { Credential } from "@/app/actions/credentials";

function getExpiryTimestamp(expiresAt: string | null): number {
  if (!expiresAt) return Infinity;
  return new Date(expiresAt).getTime();
}

/**
 * Pick the primary snapshot from an account. `snapshots` is always non-empty
 * (enforced in the server action), and element 0 is primary-first by
 * construction, but we still scan defensively.
 */
function primarySnapshot(account: Account): CredentialFile {
  return account.snapshots.find((s) => s.isPrimary) ?? account.snapshots[0]!;
}

/**
 * Compare two accounts by a column. The comparator for "account" falls back
 * to the primary snapshot's `name` because accounts don't carry an email
 * field directly — callers can pass a map to enrich the name if needed.
 */
export function compareAccounts(
  a: Account,
  b: Account,
  column: SortColumn,
  accountLabels: Map<string, string>,
): number {
  switch (column) {
    case "account": {
      const aVal = (accountLabels.get(a.fingerprint) ?? "").toLowerCase();
      const bVal = (accountLabels.get(b.fingerprint) ?? "").toLowerCase();
      return aVal.localeCompare(bVal);
    }
    case "plan": {
      const aVal = formatPlan(a.plan).toLowerCase();
      const bVal = formatPlan(b.plan).toLowerCase();
      return aVal.localeCompare(bVal);
    }
    case "tier": {
      return parseTierNumeric(a.tier) - parseTierNumeric(b.tier);
    }
    case "usage": {
      // Null usage (not polled yet) sorts to the end in both directions by
      // comparing against -Infinity; callers reverse for "desc" themselves.
      const aVal = a.usagePercent ?? -1;
      const bVal = b.usagePercent ?? -1;
      return aVal - bVal;
    }
    case "firstSeen": {
      const aPrim = primarySnapshot(a);
      const bPrim = primarySnapshot(b);
      return (
        new Date(aPrim.createdAt).getTime() -
        new Date(bPrim.createdAt).getTime()
      );
    }
    case "tokenExpiry": {
      const aPrim = primarySnapshot(a);
      const bPrim = primarySnapshot(b);
      return (
        getExpiryTimestamp(aPrim.expiresAt) -
        getExpiryTimestamp(bPrim.expiresAt)
      );
    }
    case "mcps": {
      // `Account` has no aggregated mcp field; we sort by the primary
      // credential row's mcp count, pulled from the per-id lookup map.
      // Without the map we can't compare, so treat both as 0.
      return 0;
    }
  }
}

/**
 * Compare two snapshot rows inside the expanded sub-table.
 */
export function compareSnapshots(
  a: CredentialFile,
  b: CredentialFile,
  column: SnapshotSortColumn,
): number {
  switch (column) {
    case "name":
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    case "primary":
      // Primary first when asc, so we encode `true` as lower.
      if (a.isPrimary === b.isPrimary) return 0;
      return a.isPrimary ? -1 : 1;
    case "tokenExpiry":
      return getExpiryTimestamp(a.expiresAt) - getExpiryTimestamp(b.expiresAt);
    case "firstSeen":
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  }
}

/**
 * MCP-count lookup helper: caller supplies a map from snapshot id to
 * comma-joined providers string, and we return the count. Used by the
 * account-row column so MCP sort keeps working even though mcp lives on
 * the underlying `Credential`, not on `Account`.
 */
export function mcpCountForAccount(
  account: Account,
  credentialsById: Map<string, Credential>,
): number {
  const primary = primarySnapshot(account);
  const cred = credentialsById.get(primary.id);
  if (!cred) return 0;
  return parseMcpProviders(cred.mcpProviders).length;
}
