import { getAgentBaseUrl } from "~/lib";
import { theme } from "~/components/theme";

import { RadarPanel } from "./radar-panel";

/**
 * Radar source panel (task 2.1). Server component: gates on the agent URL
 * (rendering the "configure agent" message when unset — matching the
 * web-dashboard convention) and otherwise mounts the live {@link RadarPanel},
 * which fetches `GET /sources`, renders one row per source, and offers
 * per-source scan-log / request-history drawers plus hide/show toggles.
 */
export default function RadarPage() {
  const agentBaseUrl = getAgentBaseUrl();

  if (!agentBaseUrl) {
    return (
      <main
        style={{
          padding: "3rem",
          maxWidth: 720,
          margin: "0 auto",
          fontFamily: theme.mono,
        }}
      >
        <h1 style={{ fontSize: "1.25rem" }}>Radar — agent not configured</h1>
        <p style={{ lineHeight: 1.6 }}>
          Set <code>NEXT_PUBLIC_NEXUS_AGENT_URL</code> to the base URL of a Nexus
          agent (for example <code>http://100.73.182.4:7400</code> over the
          tailnet), then restart the dev server.
        </p>
        <p style={{ lineHeight: 1.6, color: theme.muted }}>
          The Radar panel reads the mx source index from that agent. Until the
          URL is set there is nothing to connect to.
        </p>
      </main>
    );
  }

  return (
    <main
      style={{
        padding: "2.5rem 1.5rem",
        maxWidth: 820,
        margin: "0 auto",
        fontFamily: theme.mono,
      }}
    >
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: "1.25rem", margin: 0 }}>Radar</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: theme.muted }}>
          source index · agent <code>{agentBaseUrl}</code>
        </p>
      </header>
      <RadarPanel agentBaseUrl={agentBaseUrl} />
    </main>
  );
}
