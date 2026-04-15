// Credential data comes from live agent — must render on each request
export const dynamic = "force-dynamic";

import { fetchCredentials } from "../actions/credentials";
import type { Credential, CredentialGroup } from "../actions/credentials";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/** Extract multiplier from tier string, e.g. "default_claude_max_20x" → "20x" */
function parseTier(tier: string | null): string {
  if (!tier) return "—";
  const match = tier.match(/(\d+x)/);
  return match ? match[1]! : tier;
}

/** Capitalize subscription type: "max" → "Max" */
function formatPlan(sub: string | null): string {
  if (!sub) return "—";
  return sub.charAt(0).toUpperCase() + sub.slice(1);
}

/** Compute days remaining from expiresAt, or "expired" */
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

/** Color for plan badge background */
function planBadgeColor(sub: string | null): {
  bg: string;
  fg: string;
} {
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

/** Color for status text */
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

/** Build a summary string like "15 Max (20x) · 3 Team (5x)" */
function buildPlanSummary(credentials: Credential[]): string {
  const planCounts = new Map<string, { count: number; tier: string }>();
  for (const cred of credentials) {
    const plan = formatPlan(cred.subscriptionType);
    const tier = parseTier(cred.rateLimitTier);
    const key = `${plan}|${tier}`;
    const existing = planCounts.get(key);
    if (existing) {
      existing.count++;
    } else {
      planCounts.set(key, { count: 1, tier });
    }
  }
  const parts: string[] = [];
  for (const [key, { count, tier }] of planCounts) {
    const plan = key.split("|")[0];
    if (plan && plan !== "—") {
      parts.push(`${count} ${plan} (${tier})`);
    }
  }
  return parts.length > 0 ? parts.join(" \u00b7 ") : "";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PlanBadge({ subscriptionType }: { subscriptionType: string | null }) {
  const label = formatPlan(subscriptionType);
  if (label === "—") return <span style={{ color: "var(--color-fg-muted)" }}>—</span>;
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
    <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--font-size-xs)" }}>
      {formatNumber(input)} in / {formatNumber(output)} out
    </span>
  );
}

// ---------------------------------------------------------------------------
// Table row
// ---------------------------------------------------------------------------

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
      // CSS hover via class would be ideal but we use inline styles per project convention
      // The hover effect is handled via the global stylesheet addition below
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
// Page
// ---------------------------------------------------------------------------

export default async function CredentialsPage() {
  const { groups, credentials, totalAccounts } = await fetchCredentials();

  const planSummary = buildPlanSummary(credentials);

  // Build a map from credential id to its group (for usage lookup)
  const credGroupMap = new Map<string, CredentialGroup>();
  for (const group of groups) {
    for (const member of group.members) {
      credGroupMap.set(member.id, group);
    }
  }

  // Flatten all credentials sorted: primary first within each group, then by name
  const flatCredentials = groups.flatMap((g) => g.members);

  return (
    <div>
      {/* Hover style for table rows — injected once */}
      <style
        dangerouslySetInnerHTML={{
          __html: `.cred-row:hover { background: var(--color-surface-raised) !important; }`,
        }}
      />

      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "var(--space-6)",
        }}
      >
        <h1
          style={{
            fontSize: "var(--font-size-2xl)",
            fontWeight: "var(--font-weight-bold)",
            color: "var(--color-fg)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Credentials
        </h1>
        <span
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--color-fg-muted)",
          }}
        >
          {totalAccounts} account{totalAccounts !== 1 ? "s" : ""}
          {planSummary ? ` \u00b7 ${planSummary}` : ""}
        </span>
      </div>

      {flatCredentials.length === 0 ? (
        <p style={{ color: "var(--color-fg-muted)" }}>
          No credentials found. Ensure the agent is running and has credential
          files configured.
        </p>
      ) : (
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
                {["Account", "Plan", "Tier", "Status", "Rate Limits", "Expires", "Usage (24h)"].map(
                  (label) => (
                    <th
                      key={label}
                      style={{
                        padding: "var(--space-2) var(--space-3)",
                        textAlign: label === "Rate Limits" ? "right" : "left",
                        fontSize: "var(--font-size-xs)",
                        fontWeight: "var(--font-weight-medium)",
                        color: "var(--color-fg-muted)",
                        textTransform: "uppercase" as const,
                        letterSpacing: "var(--tracking-wide)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {flatCredentials.map((cred) => (
                <CredentialRow
                  key={cred.id}
                  credential={cred}
                  group={credGroupMap.get(cred.id)!}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
