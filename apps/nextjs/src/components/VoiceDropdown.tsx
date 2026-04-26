"use client";

import { useState } from "react";

/**
 * Voice selector for ElevenLabs synthesis.
 *
 * When the agent's `/elevenlabs/voices` proxy returned successfully, the
 * dropdown is populated. When it returned 5xx (the action returns
 * `{ voices: [] }` in that case) and `allowCustom` is set, we render a
 * free-form text input so the user can still save a known voice ID without
 * blocking on the third-party outage.
 */
export interface Voice {
  voiceId: string;
  name: string;
  labels?: Record<string, string>;
}

export interface VoiceDropdownProps {
  voices: Voice[];
  value: string | null;
  onChange: (voiceId: string) => void;
  /** Default true — show a text input when `voices` is empty. */
  allowCustom?: boolean;
  id?: string;
}

const inputStyle = {
  width: "100%",
  padding: "var(--space-2) var(--space-3)",
  fontSize: "var(--font-size-sm)",
  background: "var(--color-surface-raised)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  color: "var(--color-fg)",
  outline: "none",
} as const;

function formatLabel(voice: Voice): string {
  const language = voice.labels?.language;
  return language ? `${voice.name} — ${language}` : voice.name;
}

export function VoiceDropdown({
  voices,
  value,
  onChange,
  allowCustom = true,
  id,
}: VoiceDropdownProps) {
  // Local copy of the text-input value for the empty-list fallback. We
  // initialize it from `value` so the user sees their stored voice ID even
  // when the proxy is down.
  const [customDraft, setCustomDraft] = useState(value ?? "");

  if (voices.length === 0 && allowCustom) {
    return (
      <input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={customDraft}
        placeholder="Voice ID (voice list unavailable)"
        data-testid="elevenlabs-voice-custom"
        onChange={(e) => {
          const next = e.target.value;
          setCustomDraft(next);
          onChange(next);
        }}
        style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
      />
    );
  }

  return (
    <select
      id={id}
      value={value ?? ""}
      data-testid="elevenlabs-voice-dropdown"
      onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, cursor: "pointer" }}
    >
      <option value="" disabled>
        Select a voice
      </option>
      {voices.map((voice) => (
        <option key={voice.voiceId} value={voice.voiceId}>
          {formatLabel(voice)}
        </option>
      ))}
    </select>
  );
}
