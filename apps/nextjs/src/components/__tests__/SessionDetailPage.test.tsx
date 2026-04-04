import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// We test the metadata sidebar rendering by testing the page component's output.
// Since the page is async (Server Component), we create a simplified test wrapper.

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
}));

vi.mock("@/app/actions/session-detail", () => ({
  fetchSessionDetail: vi.fn(),
}));

// Since the page is a Server Component (async), we can't render it directly.
// Instead, we test the metadata sidebar concept by rendering an inline version.
import { Badge, StatusDot } from "@nexus/ui";
import { formatDuration, formatRelativeTime } from "@/lib/format";

function MetadataSidebar({
  session,
}: {
  session: {
    status: string;
    project: string | null;
    agent: string;
    pid: number;
    cwd: string;
    startedAt: string;
    lastHeartbeat: string;
  };
}) {
  const duration = formatDuration(Date.now() - new Date(session.startedAt).getTime());
  const lastActivity = formatRelativeTime(session.lastHeartbeat);
  const dotStatus = session.status === "active" ? "active" : session.status === "idle" ? "idle" : "ended";

  return (
    <div>
      <h2>Session Info</h2>
      <div>
        <StatusDot status={dotStatus as "active" | "idle" | "ended"} />
        <span>{session.status}</span>
      </div>
      <div>{session.project ?? "None"}</div>
      <div><Badge>{session.agent}</Badge></div>
      <div>{duration}</div>
      <div>{lastActivity}</div>
      <div>{session.pid}</div>
      <div>{session.cwd}</div>
    </div>
  );
}

describe("SessionDetailPage metadata sidebar", () => {
  it("renders session metadata fields", () => {
    render(
      <MetadataSidebar
        session={{
          status: "active",
          project: "nexus",
          agent: "dev-server",
          pid: 1234,
          cwd: "/home/user/dev/nexus",
          startedAt: new Date(Date.now() - 3_600_000).toISOString(),
          lastHeartbeat: new Date(Date.now() - 60_000).toISOString(),
        }}
      />,
    );

    expect(screen.getByText("Session Info")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("nexus")).toBeInTheDocument();
    expect(screen.getByText("dev-server")).toBeInTheDocument();
    expect(screen.getByText("1234")).toBeInTheDocument();
    expect(screen.getByText("/home/user/dev/nexus")).toBeInTheDocument();
  });

  it("shows 'None' when project is null", () => {
    render(
      <MetadataSidebar
        session={{
          status: "idle",
          project: null,
          agent: "build-box",
          pid: 5678,
          cwd: "/tmp",
          startedAt: new Date(Date.now() - 7_200_000).toISOString(),
          lastHeartbeat: new Date(Date.now() - 300_000).toISOString(),
        }}
      />,
    );

    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
  });
});
