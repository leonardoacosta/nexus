// Credential data comes from the live agent — render on every request.
export const dynamic = "force-dynamic";

import {
  fetchCredentials,
  listVoices,
} from "@/app/actions/elevenlabs-credentials";
import { ElevenlabsForm } from "./ElevenlabsForm";

/**
 * `/integrations/elevenlabs` — credential management surface for the
 * ElevenLabs TTS channel.
 *
 * The page is a server component that fan-outs to the agent in parallel for
 * the masked credential row and the cached voice list, then hands both to
 * the client form. The agent performs all encryption / decryption and the
 * upstream ElevenLabs HTTP calls — the dashboard never sees raw API keys.
 *
 * Errors surface as a banner so the user can self-diagnose (agent
 * unreachable, encryption key not configured, etc.) without ever rendering
 * a confusingly empty form.
 *
 * Spec: openspec/changes/add-elevenlabs-credential/specs/elevenlabs-credential/spec.md
 */
export default async function ElevenlabsIntegrationPage() {
  let initialCredentials: Awaited<ReturnType<typeof fetchCredentials>> | null =
    null;
  let initialVoices: Awaited<ReturnType<typeof listVoices>> = { voices: [] };
  let loadError: string | null = null;

  try {
    [initialCredentials, initialVoices] = await Promise.all([
      fetchCredentials(),
      listVoices(),
    ]);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "var(--space-2)",
          gap: "var(--space-4)",
          flexWrap: "wrap",
        }}
      >
        <h1
          style={{
            fontSize: "var(--font-size-2xl)",
            fontWeight: "var(--font-weight-bold)",
            color: "var(--color-fg)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          ElevenLabs
          {initialCredentials ? (
            <span
              style={{
                color: "var(--color-fg-muted)",
                fontWeight: "var(--font-weight-normal)",
              }}
            >
              {" · "}
              {initialCredentials.agentId}
            </span>
          ) : null}
        </h1>
      </div>
      <p
        style={{
          fontSize: "var(--font-size-sm)",
          color: "var(--color-fg-muted)",
          marginBottom: "var(--space-6)",
          maxWidth: "60ch",
        }}
      >
        Manage the ElevenLabs API key and voice this agent uses for TTS
        notifications. Keys are encrypted at rest and rotate without
        restarting the agent.
      </p>

      {loadError ? (
        <div
          style={{
            padding: "var(--space-4)",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--color-error)",
            background: "var(--color-error-ghost)",
            color: "var(--color-fg)",
          }}
        >
          <p
            style={{
              fontWeight: "var(--font-weight-semibold)",
              marginBottom: "var(--space-2)",
            }}
          >
            Could not load ElevenLabs credentials
          </p>
          <p
            style={{
              fontSize: "var(--font-size-sm)",
              color: "var(--color-fg-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {loadError}
          </p>
        </div>
      ) : initialCredentials ? (
        <ElevenlabsForm
          initialCredentials={initialCredentials}
          initialVoices={initialVoices.voices}
        />
      ) : null}
    </div>
  );
}
