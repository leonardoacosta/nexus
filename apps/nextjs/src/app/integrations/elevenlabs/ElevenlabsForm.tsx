"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  ElevenlabsCredentialsResponse,
  ElevenlabsVoicesResponse,
} from "@nexus/core";
import {
  deleteCredentials,
  saveCredentials,
  testCredentials,
} from "@/app/actions/elevenlabs-credentials";
import { Card } from "@nexus/ui";
import { MaskedKeyInput } from "@/components/MaskedKeyInput";
import { VoiceDropdown } from "@/components/VoiceDropdown";
import { TestConnectionPanel } from "@/components/TestConnectionPanel";

type Voice = ElevenlabsVoicesResponse["voices"][number];

interface ElevenlabsFormProps {
  initialCredentials: ElevenlabsCredentialsResponse;
  initialVoices: Voice[];
}

const labelStyle = {
  fontSize: "var(--font-size-xs)",
  color: "var(--color-fg-muted)",
  marginBottom: "var(--space-1_5)",
  display: "block" as const,
  textTransform: "uppercase" as const,
  letterSpacing: "var(--tracking-wide)",
};

const primaryButtonStyle = {
  padding: "var(--space-2) var(--space-6)",
  fontSize: "var(--font-size-sm)",
  fontWeight: "var(--font-weight-medium)",
  color: "var(--color-primary-fg)",
  background: "var(--color-primary)",
  border: "1px solid var(--color-primary)",
  borderRadius: "var(--radius-md)",
  cursor: "pointer",
} as const;

const dangerLinkStyle = {
  fontSize: "var(--font-size-sm)",
  color: "var(--color-error)",
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  textDecoration: "underline",
} as const;

/**
 * Format a recent absolute UTC timestamp as a coarse relative string.
 * Agent and dashboard clocks come from the same Tailscale tailnet so
 * sub-second drift is fine here — this is a UX hint, not an audit log.
 */
function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Client form for `/integrations/elevenlabs`.
 *
 * Holds the per-field draft state (`apiKeyDraft`, `voiceIdDraft`), composes
 * the masked input + voice dropdown + test panel, and dispatches the save
 * via the `saveCredentials` server action. Refreshes the page afterward
 * via `router.refresh()` so the masked GET response (and the persisted
 * lastTested* fields) come back from the agent rather than being optimistic
 * client guesses.
 */
export function ElevenlabsForm({
  initialCredentials,
  initialVoices,
}: ElevenlabsFormProps) {
  const router = useRouter();
  const [apiKeyDraft, setApiKeyDraft] = useState<string | undefined>(undefined);
  const [voiceIdDraft, setVoiceIdDraft] = useState<string | null>(
    initialCredentials.voiceId,
  );
  const [isPending, startTransition] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const voiceById = useMemo(() => {
    const map = new Map<string, Voice>();
    for (const v of initialVoices) map.set(v.voiceId, v);
    return map;
  }, [initialVoices]);

  const hasStoredKey = initialCredentials.hasKey;
  const hasDraftKey = apiKeyDraft !== undefined && apiKeyDraft.length > 0;
  const voiceChanged = voiceIdDraft !== initialCredentials.voiceId;
  const dirty = hasDraftKey || voiceChanged;

  const handleSave = () => {
    setSaveError(null);
    setSavedAt(null);
    startTransition(async () => {
      try {
        const patch: {
          apiKey?: string;
          voiceId?: string;
          voiceName?: string;
        } = {};
        if (hasDraftKey) patch.apiKey = apiKeyDraft;
        if (voiceChanged && voiceIdDraft) {
          patch.voiceId = voiceIdDraft;
          const matched = voiceById.get(voiceIdDraft);
          if (matched?.name) patch.voiceName = matched.name;
        }
        if (Object.keys(patch).length === 0) return;
        await saveCredentials(patch);
        setSavedAt(Date.now());
        // Pull the masked GET shape back from the agent (lastTested* etc).
        router.refresh();
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const handleDelete = () => {
    if (
      !confirm(
        "Delete the stored ElevenLabs credentials? The agent will fall back to the ELEVENLABS_API_KEY env var (or signal-only TTS if unset).",
      )
    ) {
      return;
    }
    setSaveError(null);
    startTransition(async () => {
      try {
        await deleteCredentials();
        setApiKeyDraft(undefined);
        setVoiceIdDraft(null);
        router.refresh();
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  // Test panel needs SOMETHING to talk to ElevenLabs with — either a stored
  // key the agent can decrypt, or a draft the user is about to save. We
  // don't try to be clever and proactively save: the spec is clear that
  // Save and Test are independent buttons.
  const testDisabled = !hasStoredKey;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-6)",
      }}
    >
      {!hasStoredKey ? (
        <div
          style={{
            padding: "var(--space-4)",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--color-border)",
            background: "var(--color-primary-ghost)",
            color: "var(--color-fg)",
            fontSize: "var(--font-size-sm)",
          }}
          data-testid="elevenlabs-empty-state"
        >
          Paste your ElevenLabs API key from{" "}
          <a
            href="https://elevenlabs.io/app/settings/api-keys"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--color-primary)" }}
          >
            elevenlabs.io/settings/api-keys
          </a>{" "}
          to enable TTS notifications.
        </div>
      ) : null}

      <Card title="Credentials">
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-4)",
          }}
        >
          <div>
            <label htmlFor="elevenlabs-api-key" style={labelStyle}>
              API key
            </label>
            <MaskedKeyInput
              id="elevenlabs-api-key"
              hasKey={hasStoredKey}
              onChange={setApiKeyDraft}
            />
          </div>

          <div>
            <label htmlFor="elevenlabs-voice" style={labelStyle}>
              Voice
            </label>
            <VoiceDropdown
              id="elevenlabs-voice"
              voices={initialVoices}
              value={voiceIdDraft}
              onChange={setVoiceIdDraft}
            />
          </div>

          <div>
            <span style={labelStyle}>Test</span>
            <TestConnectionPanel
              onTest={testCredentials}
              disabled={testDisabled}
            />
            {initialCredentials.lastTestOkAt &&
            initialCredentials.lastTestStatusCode !== null ? (
              <p
                suppressHydrationWarning
                style={{
                  marginTop: "var(--space-2)",
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-fg-muted)",
                }}
              >
                Last tested: {formatRelative(initialCredentials.lastTestOkAt)} —
                status {initialCredentials.lastTestStatusCode}
              </p>
            ) : null}
          </div>
        </div>
      </Card>

      {saveError ? (
        <p
          role="alert"
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--color-error)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {saveError}
        </p>
      ) : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-4)",
          flexWrap: "wrap",
        }}
      >
        {hasStoredKey ? (
          <button
            type="button"
            onClick={handleDelete}
            disabled={isPending}
            data-testid="elevenlabs-delete"
            style={dangerLinkStyle}
          >
            Delete credentials
          </button>
        ) : (
          <span />
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
          }}
        >
          {savedAt && !saveError ? (
            <span
              style={{
                fontSize: "var(--font-size-sm)",
                color: "var(--color-success)",
              }}
            >
              Saved
            </span>
          ) : null}
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || isPending}
            data-testid="elevenlabs-save"
            style={{
              ...primaryButtonStyle,
              cursor: !dirty || isPending ? "not-allowed" : "pointer",
              opacity: !dirty || isPending ? 0.6 : 1,
            }}
          >
            {isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
