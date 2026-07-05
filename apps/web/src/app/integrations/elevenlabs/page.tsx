import { getAgentBaseUrl } from "~/lib";
import { theme } from "~/components/theme";

import { ElevenLabsPanel } from "./Panel";

/**
 * ElevenLabs credential management page (task 3.5). Server component: gates on
 * the agent URL (rendering the "configure agent" message when unset, matching
 * the web-dashboard convention) and otherwise mounts the {@link ElevenLabsPanel}
 * which manages the masked key, voice, and test/save/delete actions against the
 * agent's `/elevenlabs/*` REST endpoints.
 */
export default function ElevenLabsIntegrationPage() {
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
        <h1 style={{ fontSize: "1.25rem" }}>ElevenLabs — agent not configured</h1>
        <p style={{ lineHeight: 1.6 }}>
          Set <code>NEXT_PUBLIC_NEXUS_AGENT_URL</code> to the base URL of a Nexus
          agent (for example <code>http://100.73.182.4:7400</code> over the
          tailnet), then restart the dev server.
        </p>
        <p style={{ lineHeight: 1.6, color: theme.muted }}>
          Credentials are stored encrypted on that agent. Until the URL is set
          there is nothing to connect to.
        </p>
      </main>
    );
  }

  return (
    <main
      style={{
        padding: "2.5rem 1.5rem",
        maxWidth: 640,
        margin: "0 auto",
        fontFamily: theme.mono,
      }}
    >
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: "1.25rem", margin: 0 }}>ElevenLabs</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: theme.muted }}>
          TTS credentials · agent <code>{agentBaseUrl}</code>
        </p>
      </header>
      <ElevenLabsPanel agentBaseUrl={agentBaseUrl} />
    </main>
  );
}
