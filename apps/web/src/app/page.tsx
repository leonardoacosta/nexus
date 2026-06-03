import { getAgentBaseUrl } from "~/lib";
import { SessionList } from "~/components/SessionList";
import { theme } from "~/components/theme";

/**
 * Home / session-list view (task 3.5). Server component: gates on the agent URL
 * (rendering the "configure agent" message when unset — scaffold scenario
 * "Missing agent URL is surfaced") and otherwise mounts the live
 * {@link SessionList}, which polls `GET /sessions` and offers a "new session"
 * action. Sessions are server-persisted, so a reload re-fetches the same active
 * set.
 */
export default function HomePage() {
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
        <h1 style={{ fontSize: "1.25rem" }}>Nexus Web — agent not configured</h1>
        <p style={{ lineHeight: 1.6 }}>
          Set <code>NEXT_PUBLIC_NEXUS_AGENT_URL</code> to the base URL of a Nexus
          agent (for example <code>http://100.73.182.4:7400</code> over the
          tailnet), then restart the dev server.
        </p>
        <p style={{ lineHeight: 1.6, color: theme.muted }}>
          The web dashboard attaches to a single agent over Tailscale (ws, no
          TLS). Until the URL is set there is nothing to connect to.
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
        <h1 style={{ fontSize: "1.25rem", margin: 0 }}>Nexus Web</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: theme.muted }}>
          agent <code>{agentBaseUrl}</code>
        </p>
      </header>
      <SessionList agentBaseUrl={agentBaseUrl} />
    </main>
  );
}
