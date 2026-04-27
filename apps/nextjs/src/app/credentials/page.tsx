// Credential data comes from live agent — must render on each request
export const dynamic = "force-dynamic";

import { fetchCredentials } from "../actions/credentials";
import type { Credential } from "../actions/credentials";
import { AccountsTable } from "@/components/credentials-table";
import { getAgentBaseUrl } from "@/lib/agent-url";
import type { Reachability } from "@/lib/agent-reachability";
import { fetchWithTimeout } from "@nexus/core/fetch";
import { credentialsActiveResponseSchema } from "@nexus/core";

// ---------------------------------------------------------------------------
// Banner copy helpers — mirror the notifications page so both surfaces show
// the same accurate diagnostic per failure mode instead of collapsing every
// failure into a generic "Agent unreachable" string.
// ---------------------------------------------------------------------------

function bannerTitleForReachability(r: Reachability): string {
  if (r.ok) return "";
  switch (r.reason) {
    case "no-agent":
      return "No agent registered";
    case "timeout":
      return `Agent ${r.agent.name} not responding`;
    case "stale-binary":
      return `Agent build ${r.build.sha} missing required capability`;
    case "http-error":
      return `Agent ${r.agent.name} returned HTTP ${r.status}`;
  }
}

function bannerDetailForReachability(r: Reachability): string {
  if (r.ok) return "";
  switch (r.reason) {
    case "no-agent":
      return "Add an agent in Settings → Agents to manage credentials.";
    case "timeout":
      return `${r.agent.host}:${r.agent.port} did not respond within 5s — check the daemon.`;
    case "stale-binary":
      return `Missing: ${r.missing.join(", ")}. Rebuild and restart the agent.`;
    case "http-error":
      return `Check the agent logs at ${r.agent.host}:${r.agent.port} for the underlying error.`;
  }
}

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

/** Build a summary string like "15 Max (20x) · 3 Team (5x)" from flat credentials. */
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

/**
 * Fetch the agent's currently-resolved `.credentials.json` path so the
 * `ActiveBadge` tooltip can show it. Falls back to null on any error —
 * the badge still renders, just without a specific path in the tooltip.
 */
async function fetchActiveResolvedPath(): Promise<string | null> {
  const resolved = await getAgentBaseUrl();
  if (!resolved) return null;
  try {
    const res = await fetchWithTimeout(
      `${resolved.baseUrl}/credentials/active`,
      {
        timeout: 3_000,
        headers: {
          "x-nexus-secret": process.env.NEXUS_ATTACH_SECRET ?? "",
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    const parsed = credentialsActiveResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    return parsed.data.resolvedPath;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function CredentialsPage() {
  const [
    {
      accounts,
      credentials,
      totalAccounts,
      agentSource,
      agentReachable,
      activeFingerprint,
      reachability,
    },
    resolvedPath,
  ] = await Promise.all([fetchCredentials(), fetchActiveResolvedPath()]);

  const planSummary = buildPlanSummary(credentials);
  const hasActiveAccount = activeFingerprint !== null;

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
          gap: "var(--space-4)",
          flexWrap: "wrap",
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
          {agentReachable && agentSource !== "unknown" ? (
            <span style={{ opacity: 0.6 }}>{` \u00b7 via ${agentSource}`}</span>
          ) : null}
          {agentReachable && accounts.length > 0 && !hasActiveAccount ? (
            <span
              style={{
                opacity: 0.8,
                color: "var(--color-warning)",
                marginLeft: "var(--space-2)",
              }}
            >
              {"\u00b7 no active credential detected"}
            </span>
          ) : null}
        </span>
      </div>

      {!agentReachable ? (
        <div
          data-testid="agent-banner"
          style={{
            padding: "var(--space-4)",
            borderRadius: "var(--radius-md)",
            border: "1px solid #d4a017",
            background: "rgba(212, 160, 23, 0.08)",
            color: "#b8860b",
          }}
        >
          <p
            style={{
              fontWeight: "var(--font-weight-semibold)",
              marginBottom: "var(--space-2)",
            }}
          >
            {bannerTitleForReachability(reachability)}
          </p>
          <p
            style={{
              fontSize: "var(--font-size-sm)",
              color: "var(--color-fg-muted)",
            }}
          >
            {bannerDetailForReachability(reachability)}
          </p>
        </div>
      ) : accounts.length === 0 ? (
        <p style={{ color: "var(--color-fg-muted)" }}>
          No credentials found. The agent is running but has no credential files
          configured.
        </p>
      ) : (
        <AccountsTable
          accounts={accounts}
          credentials={credentials}
          resolvedPath={resolvedPath}
        />
      )}
    </div>
  );
}
