// Credential data comes from live agent — must render on each request
export const dynamic = "force-dynamic";

import { fetchCredentials } from "../actions/credentials";
import type { Credential, CredentialGroup } from "../actions/credentials";
import { CredentialsTable } from "@/components/CredentialsTable";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Page
// ---------------------------------------------------------------------------

export default async function CredentialsPage() {
  const { groups, credentials, totalAccounts } = await fetchCredentials();

  const planSummary = buildPlanSummary(credentials);

  // Build a plain object map from credential id to its group (serializable for client)
  const credGroupMap: Record<string, CredentialGroup> = {};
  for (const group of groups) {
    for (const member of group.members) {
      credGroupMap[member.id] = group;
    }
  }

  // Flatten all credentials: primary first within each group, then by name
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
        <CredentialsTable
          credentials={flatCredentials}
          credGroupMap={credGroupMap}
        />
      )}
    </div>
  );
}
