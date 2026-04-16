/**
 * Dashboard banner shown when the UI is rendering from a shared Postgres
 * snapshot but no agent is currently reporting live.
 *
 * Context: every nexus-agent writes to the same shared DB. The dashboard now
 * reads exclusively from that DB (finalize-audit-cleanup, Wave 3). When all
 * agents are stopped the page still renders — possibly stale — data, so this
 * banner surfaces the "no live reporter" state without blocking the view.
 *
 * Decision: non-dismissable. The banner auto-disappears once any agent checks
 * in again (agentCount / onlineAgentCount from fetchSessions()).
 *
 * Two copy variants:
 *   - agentCount === 0  → "No agents configured"
 *   - agentCount > 0 && onlineAgentCount === 0 → "All agents offline"
 */

interface AgentsOfflineBannerProps {
  agentCount: number;
  onlineAgentCount: number;
}

export function AgentsOfflineBanner({
  agentCount,
  onlineAgentCount,
}: AgentsOfflineBannerProps) {
  // Only render in the two "no live signal" states.
  if (agentCount > 0 && onlineAgentCount > 0) return null;

  const isUnconfigured = agentCount === 0;
  const title = isUnconfigured
    ? "No agents configured"
    : "All agents offline";
  const description = isUnconfigured
    ? "Register a nexus-agent to start seeing live sessions and health data."
    : "Showing cached data from the last successful report — it may be stale until an agent reconnects.";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="agents-offline-banner"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--space-3)",
        padding: "var(--space-3) var(--space-4)",
        marginBottom: "var(--space-4)",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--color-warning, #d97706)",
        background: "var(--color-warning-ghost, rgba(217, 119, 6, 0.1))",
        color: "var(--color-warning, #d97706)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          fontSize: "var(--font-size-base)",
          lineHeight: 1,
          marginTop: 2,
        }}
      >
        !
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontSize: "var(--font-size-sm)",
            fontWeight: "var(--font-weight-semibold)",
            color: "var(--color-warning, #d97706)",
            margin: 0,
          }}
        >
          {title}
        </p>
        <p
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-fg-muted)",
            marginTop: "var(--space-1)",
            marginBottom: 0,
          }}
        >
          {description}
        </p>
      </div>
    </div>
  );
}
