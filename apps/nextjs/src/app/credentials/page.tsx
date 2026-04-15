// Credential data comes from live agent — must render on each request
export const dynamic = "force-dynamic";

import { fetchCredentials } from "../actions/credentials";
import type { CredentialGroup, Credential } from "../actions/credentials";

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

function UsageSummary({ usage }: { usage: NonNullable<CredentialGroup["usage"]> }) {
  const parts: string[] = [];
  if (usage.input || usage.output) {
    parts.push(`${formatNumber(usage.input)} in / ${formatNumber(usage.output)} out`);
  }
  if (usage.cost_usd != null) {
    parts.push(`$${usage.cost_usd.toFixed(2)}`);
  }
  if (usage.session_count) {
    parts.push(`${usage.session_count} session${usage.session_count !== 1 ? "s" : ""}`);
  }
  if (usage.turn_count) {
    parts.push(`${usage.turn_count} turn${usage.turn_count !== 1 ? "s" : ""}`);
  }

  if (parts.length === 0) return null;

  return (
    <div
      style={{
        fontSize: "var(--font-size-sm)",
        color: "var(--color-fg-dim)",
        borderTop: "1px solid var(--color-border)",
        paddingTop: "var(--space-3)",
        marginTop: "var(--space-3)",
      }}
    >
      <span style={{ fontWeight: "var(--font-weight-medium)", color: "var(--color-fg-muted)" }}>
        Usage (24h):
      </span>{" "}
      {parts.join(" | ")}
    </div>
  );
}

function MemberRow({
  credential,
  isPrimary,
}: {
  credential: Credential;
  isPrimary: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "var(--space-3)",
        padding: "var(--space-2) 0",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--font-size-sm)",
          color: isPrimary ? "var(--color-fg)" : "var(--color-fg-dim)",
          fontWeight: isPrimary
            ? "var(--font-weight-medium)"
            : "var(--font-weight-normal)",
        }}
      >
        {isPrimary ? "\u2605 " : "  "}
        {credential.id}
        {isPrimary ? " (primary)" : ""}
      </span>

      <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-fg-muted)" }}>
        Created {timeAgo(credential.createdAt)}
      </span>

      {credential.rateLimitCount > 0 && (
        <span
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-warning)",
            background: "var(--color-warning-ghost)",
            padding: "var(--space-0_5) var(--space-2)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          Rate limits: {credential.rateLimitCount}
        </span>
      )}

      {credential.leasedBy && (
        <span
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-info)",
            background: "var(--color-info-ghost)",
            padding: "var(--space-0_5) var(--space-2)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          Leased: {credential.leasedBy}
        </span>
      )}

      {!isPrimary && (
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: "var(--space-2)",
          }}
        >
          <span
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-fg-muted)",
              border: "1px solid var(--color-border)",
              padding: "var(--space-0_5) var(--space-2)",
              borderRadius: "var(--radius-sm)",
              cursor: "default",
              opacity: 0.6,
            }}
          >
            Promote
          </span>
          <span
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-error)",
              border: "1px solid var(--color-border)",
              padding: "var(--space-0_5) var(--space-2)",
              borderRadius: "var(--radius-sm)",
              cursor: "default",
              opacity: 0.6,
            }}
          >
            Delete
          </span>
        </span>
      )}
    </div>
  );
}

function GroupCard({ group }: { group: CredentialGroup }) {
  const isSolo = group.members.length === 1;
  const shortFingerprint = group.fingerprint.slice(0, 12);

  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-4) var(--space-5)",
      }}
    >
      {/* Group header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          marginBottom: "var(--space-3)",
        }}
      >
        <span
          style={{
            fontSize: "var(--font-size-sm)",
            fontWeight: "var(--font-weight-semibold)",
            color: "var(--color-fg)",
          }}
        >
          Account: {shortFingerprint}...
        </span>
        {isSolo && (
          <span
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-fg-muted)",
              background: "var(--color-surface-raised)",
              padding: "var(--space-0_5) var(--space-2)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            solo
          </span>
        )}
        {!isSolo && (
          <span
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-fg-muted)",
            }}
          >
            {group.members.length} files
          </span>
        )}
      </div>

      {/* Status line */}
      <div
        style={{
          fontSize: "var(--font-size-xs)",
          color: "var(--color-fg-muted)",
          marginBottom: "var(--space-3)",
          display: "flex",
          gap: "var(--space-4)",
        }}
      >
        <span>
          Status:{" "}
          <span
            style={{
              color:
                group.primary.status === "available"
                  ? "var(--color-success)"
                  : group.primary.status === "rate_limited"
                    ? "var(--color-warning)"
                    : "var(--color-fg-dim)",
            }}
          >
            {group.primary.status}
          </span>
        </span>
        <span>Type: {group.primary.type}</span>
      </div>

      {/* Members */}
      <div
        style={{
          borderTop: "1px solid var(--color-border)",
          paddingTop: "var(--space-2)",
        }}
      >
        {group.members.map((member) => (
          <MemberRow
            key={member.id}
            credential={member}
            isPrimary={member.id === group.primary.id}
          />
        ))}
      </div>

      {/* Usage summary */}
      {group.usage && <UsageSummary usage={group.usage} />}
    </div>
  );
}

export default async function CredentialsPage() {
  const { groups, totalAccounts, totalFiles } = await fetchCredentials();

  return (
    <div>
      <h1
        style={{
          fontSize: "var(--font-size-2xl)",
          fontWeight: "var(--font-weight-bold)",
          color: "var(--color-fg)",
          marginBottom: "var(--space-2)",
          letterSpacing: "var(--tracking-tight)",
        }}
      >
        Credentials
      </h1>

      <p
        style={{
          fontSize: "var(--font-size-sm)",
          color: "var(--color-fg-muted)",
          marginBottom: "var(--space-6)",
        }}
      >
        {totalAccounts} account{totalAccounts !== 1 ? "s" : ""}, {totalFiles} total
        file{totalFiles !== 1 ? "s" : ""}
      </p>

      {groups.length === 0 ? (
        <p style={{ color: "var(--color-fg-muted)" }}>
          No credentials found. Ensure the agent is running and has credential files configured.
        </p>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-4)",
          }}
        >
          {groups.map((group) => (
            <GroupCard key={group.fingerprint} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}
