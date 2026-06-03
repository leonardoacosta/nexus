import { getAgentBaseUrl } from "~/lib/agent-config";

/**
 * Home page. Foundation-batch placeholder: its single job here is to satisfy
 * the scaffold scenario "Missing agent URL is surfaced" — when
 * NEXT_PUBLIC_NEXUS_AGENT_URL is unset, render a clear configuration-required
 * message instead of crashing. The UI batch (task 3.5) replaces this with the
 * live session list driven by the agent-rest-client.
 */
export default function HomePage() {
  const agentUrl = getAgentBaseUrl();

  if (!agentUrl) {
    return (
      <main style={{ padding: "3rem", maxWidth: 640, margin: "0 auto" }}>
        <h1 style={{ fontSize: "1.25rem" }}>Nexus Web — agent not configured</h1>
        <p style={{ lineHeight: 1.6 }}>
          Set <code>NEXT_PUBLIC_NEXUS_AGENT_URL</code> to the base URL of a
          Nexus agent (for example{" "}
          <code>http://100.73.182.4:7400</code> over the tailnet), then restart
          the dev server.
        </p>
        <p style={{ lineHeight: 1.6, opacity: 0.7 }}>
          The web dashboard attaches to a single agent over Tailscale (ws, no
          TLS). Until the URL is set there is nothing to connect to.
        </p>
      </main>
    );
  }

  return (
    <main style={{ padding: "3rem", maxWidth: 640, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Nexus Web</h1>
      <p style={{ lineHeight: 1.6 }}>
        Connected agent target: <code>{agentUrl}</code>
      </p>
      <p style={{ lineHeight: 1.6, opacity: 0.7 }}>
        Session list and attach view are wired by the UI batch. Navigate to{" "}
        <code>/attach/&lt;session-id&gt;</code> to attach.
      </p>
    </main>
  );
}
