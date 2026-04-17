"use client";

import type { Credential } from "@/app/actions/credentials";

import {
  expiryColor,
  formatExpiry,
  formatRelativeTime,
  parseTier,
} from "./helpers";
import { McpBadges } from "./mcp-badges";
import { PlanBadge } from "./plan-badge";

export function CredentialRow({ credential }: { credential: Credential }) {
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
    </tr>
  );
}
