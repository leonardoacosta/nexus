import { notFound } from "next/navigation";

import { getAgentBaseUrl } from "~/lib";
import { theme } from "~/components/theme";

import { KokoroPanel } from "./KokoroPanel";
import { TelegramPanel } from "./TelegramPanel";

/**
 * Generic per-provider integrations page — `/integrations/:provider`.
 *
 * Server component: gates on the agent URL (rendering the "configure agent"
 * message when unset, matching the ElevenLabs page convention), looks the route
 * `provider` up in {@link PROVIDER_UI_REGISTRY}, and calls `notFound()` for any
 * provider not registered here. When found it mounts the provider's `Panel`,
 * which owns the masked-secret / test / save / delete actions against the
 * agent's generic `/integrations/:provider/*` REST endpoints.
 *
 * Adding a provider = one row in the registry below (+ its Panel component) and
 * one descriptor on the agent side. The ElevenLabs page keeps its own bespoke
 * route (`/integrations/elevenlabs`) and is intentionally NOT in this registry.
 *
 * Spec: openspec/changes/add-integration-registry/
 */

interface ProviderUi {
  displayName: string;
  Panel: React.ComponentType<{ agentBaseUrl: string }>;
}

const PROVIDER_UI_REGISTRY: Record<string, ProviderUi> = {
  telegram: { displayName: "Telegram", Panel: TelegramPanel },
  kokoro: { displayName: "Kokoro", Panel: KokoroPanel },
};

export default async function IntegrationProviderPage({
  params,
}: {
  params: Promise<{ provider: string }>;
}) {
  const { provider: rawProvider } = await params;
  const provider = decodeURIComponent(rawProvider);
  const entry = PROVIDER_UI_REGISTRY[provider];
  if (!entry) notFound();

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
        <h1 style={{ fontSize: "1.25rem" }}>
          {entry.displayName} — agent not configured
        </h1>
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

  const { Panel } = entry;

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
        <h1 style={{ fontSize: "1.25rem", margin: 0 }}>{entry.displayName}</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: theme.muted }}>
          Integration credentials · agent <code>{agentBaseUrl}</code>
        </p>
      </header>
      <Panel agentBaseUrl={agentBaseUrl} />
    </main>
  );
}
