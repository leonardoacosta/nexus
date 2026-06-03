import Link from "next/link";

import { getAgentBaseUrl } from "~/lib";
import { TerminalAttach } from "~/components/TerminalAttach";
import { theme } from "~/components/theme";

/**
 * Attach route — `/attach/:session`. Server component: resolves the agent URL
 * (so the unconfigured state never reaches the client renderer) and mounts the
 * interactive {@link TerminalAttach} view. The terminal core + transport wiring
 * live in the client component; this page is just the config gate + frame.
 */
export default async function AttachPage({
  params,
}: {
  params: Promise<{ session: string }>;
}) {
  const { session } = await params;
  const sessionId = decodeURIComponent(session);
  const agentBaseUrl = getAgentBaseUrl();

  if (!agentBaseUrl) {
    return (
      <main
        style={{
          padding: "3rem",
          maxWidth: 640,
          margin: "0 auto",
          fontFamily: theme.mono,
        }}
      >
        <h1 style={{ fontSize: "1.25rem" }}>Nexus Web — agent not configured</h1>
        <p style={{ lineHeight: 1.6 }}>
          Set <code>NEXT_PUBLIC_NEXUS_AGENT_URL</code> to the base URL of a Nexus
          agent (for example <code>http://100.73.182.4:7400</code> over the
          tailnet), then restart the dev server. There is no agent to attach to
          until it is set.
        </p>
        <p style={{ lineHeight: 1.6 }}>
          <Link href="/" style={{ color: theme.accent }}>
            ← Back to sessions
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <TerminalAttach sessionId={sessionId} agentBaseUrl={agentBaseUrl} />
    </main>
  );
}
