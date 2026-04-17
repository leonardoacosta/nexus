import type { Credential } from "@/app/actions/credentials";

import type { SortColumn } from "./types";
import {
  formatPlan,
  parseMcpProviders,
  parseTierNumeric,
} from "./helpers";

function getExpiryTimestamp(expiresAt: string | null): number {
  if (!expiresAt) return Infinity;
  return new Date(expiresAt).getTime();
}

export function compareCredentials(
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
      return (
        parseTierNumeric(a.rateLimitTier) - parseTierNumeric(b.rateLimitTier)
      );
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
  }
}
