import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchSessionDetail } from "@/app/actions/session-detail";
import { Badge, StatusDot } from "@nexus/ui";
import { formatDuration, formatRelativeTime } from "@/lib/format";
import { LazyTerminalPanel } from "@/components/LazyTerminalPanel";
import SessionDetailLoading from "./loading";

function getStatusDotStatus(status: string): "active" | "idle" | "ended" {
  if (status === "active") return "active";
  if (status === "idle") return "idle";
  return "ended";
}

async function SessionDetailContent({ id }: { id: string }) {
  const result = await fetchSessionDetail(id);

  if (!result) {
    notFound();
  }

  const { session, agentHost } = result;

  const duration = formatDuration(
    Date.now() - new Date(session.startedAt).getTime(),
  );
  const lastActivity = formatRelativeTime(session.lastHeartbeat);

  return (
    <>
      {/* Top bar with back navigation */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          marginBottom: "var(--space-6)",
        }}
      >
        <Link
          href="/"
          style={{
            color: "var(--color-primary)",
            textDecoration: "none",
            fontSize: "var(--font-size-sm)",
          }}
        >
          &larr; Back to Dashboard
        </Link>
        <span style={{ color: "var(--color-fg-ghost)" }}>/</span>
        <span
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--color-fg-dim)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {session.id}
        </span>
      </div>

      {/* Two-column layout */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 320px",
          gap: "var(--space-4)",
          minHeight: "calc(100vh - 200px)",
        }}
      >
        {/* Left: Terminal */}
        <div style={{ minHeight: 400 }}>
          <LazyTerminalPanel agentHost={agentHost} sessionId={session.id} />
        </div>

        {/* Right: Metadata sidebar */}
        <div
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-lg)",
            padding: "var(--space-4)",
            height: "fit-content",
          }}
        >
          <h2
            style={{
              fontSize: "var(--font-size-sm)",
              fontWeight: "var(--font-weight-medium)",
              color: "var(--color-fg-dim)",
              textTransform: "uppercase" as const,
              letterSpacing: "var(--tracking-wide)",
              marginBottom: "var(--space-4)",
            }}
          >
            Session Info
          </h2>

          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            <MetadataRow label="Status">
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                <StatusDot status={getStatusDotStatus(session.status)} />
                <span style={{ textTransform: "capitalize" as const }}>{session.status}</span>
              </div>
            </MetadataRow>

            <MetadataRow label="Project">
              {session.project ?? "None"}
            </MetadataRow>

            <MetadataRow label="Machine">
              <Badge>{session.agent}</Badge>
            </MetadataRow>

            <MetadataRow label="Duration">
              <span style={{ fontFamily: "var(--font-mono)" }}>{duration}</span>
            </MetadataRow>

            <MetadataRow label="Last Activity">
              {lastActivity}
            </MetadataRow>

            <MetadataRow label="PID">
              <span style={{ fontFamily: "var(--font-mono)" }}>{session.pid}</span>
            </MetadataRow>

            <MetadataRow label="CWD">
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--font-size-xs)",
                  wordBreak: "break-all",
                }}
              >
                {session.cwd}
              </span>
            </MetadataRow>

            {session.branch && (
              <MetadataRow label="Branch">
                <span style={{ fontFamily: "var(--font-mono)" }}>{session.branch}</span>
              </MetadataRow>
            )}

            {session.model && (
              <MetadataRow label="Model">
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--font-size-xs)" }}>
                  {session.model}
                </span>
              </MetadataRow>
            )}

            {session.totalCostUsd != null && (
              <MetadataRow label="Cost">
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  ${session.totalCostUsd.toFixed(2)}
                </span>
              </MetadataRow>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div>
      <Suspense fallback={<SessionDetailLoading />}>
        <SessionDetailContent id={id} />
      </Suspense>
    </div>
  );
}

function MetadataRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt
        style={{
          fontSize: "var(--font-size-xs)",
          color: "var(--color-fg-muted)",
          marginBottom: "var(--space-1)",
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          fontSize: "var(--font-size-sm)",
          color: "var(--color-fg)",
        }}
      >
        {children}
      </dd>
    </div>
  );
}
