"use client";

import { useEffect, useState } from "react";

import type { ElevenlabsVoice } from "~/lib/elevenlabs-client";
import { listVoices } from "~/lib/elevenlabs-client";
import { AgentHttpError } from "~/lib";
import { theme } from "~/components/theme";

/**
 * Voice selector (task 3.3). Fed by `GET /elevenlabs/voices`; each option shows
 * the voice name plus its first label value (e.g. language). When the proxy
 * returns a 5xx (upstream ElevenLabs error / no stored key yet), it degrades to
 * a free-text input so the user can still enter a known voice id by hand.
 */

const inputStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 8,
  border: `1px solid ${theme.border}`,
  background: theme.surface,
  color: theme.fg,
  fontFamily: theme.mono,
  fontSize: 14,
};

function firstLabel(v: ElevenlabsVoice): string {
  const values = v.labels ? Object.values(v.labels) : [];
  return values.length > 0 ? values[0]! : "";
}

type LoadState =
  | { phase: "loading" }
  | { phase: "list"; voices: ElevenlabsVoice[] }
  | { phase: "fallback"; reason: string };

export function VoiceDropdown({
  agentBaseUrl,
  voiceId,
  onChange,
  disabled,
}: {
  agentBaseUrl: string;
  voiceId: string;
  onChange: (voiceId: string) => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });
    listVoices(agentBaseUrl, controller.signal)
      .then((voices) => setState({ phase: "list", voices }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // 5xx (or any fetch failure) -> free-text fallback so the user is never
        // blocked from setting a voice id they already know.
        const reason =
          err instanceof AgentHttpError
            ? `voice list unavailable (status ${err.status})`
            : "voice list unavailable";
        setState({ phase: "fallback", reason });
      });
    return () => controller.abort();
  }, [agentBaseUrl]);

  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: theme.muted, fontFamily: theme.mono }}>
        Voice
      </span>

      {state.phase === "loading" && (
        <input
          value={voiceId}
          disabled
          placeholder="Loading voices…"
          style={inputStyle}
          readOnly
        />
      )}

      {state.phase === "list" && (
        <select
          value={voiceId}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle}
        >
          <option value="">— select a voice —</option>
          {/* If the stored voiceId is not in the fetched list, keep it selectable. */}
          {voiceId && !state.voices.some((v) => v.voiceId === voiceId) && (
            <option value={voiceId}>{voiceId} (current)</option>
          )}
          {state.voices.map((v) => {
            const label = firstLabel(v);
            return (
              <option key={v.voiceId} value={v.voiceId}>
                {v.name}
                {label ? ` — ${label}` : ""}
              </option>
            );
          })}
        </select>
      )}

      {state.phase === "fallback" && (
        <>
          <input
            value={voiceId}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Enter a voice id (e.g. 21m00Tcm4TlvDq8ikWAM)"
            style={inputStyle}
          />
          <span style={{ fontSize: 11, color: theme.warn, fontFamily: theme.mono }}>
            {state.reason} — enter a voice id manually.
          </span>
        </>
      )}
    </label>
  );
}
