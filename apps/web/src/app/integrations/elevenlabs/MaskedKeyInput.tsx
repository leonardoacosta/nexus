"use client";

import { theme } from "~/components/theme";

/**
 * Masked API-key input (task 3.2). When a key is already stored (`hasKey`) and
 * the user has not typed anything, the field shows placeholder bullets — the
 * stored value is NEVER sent to the browser (GET masks it), so there is nothing
 * to display. Typing or pasting overwrites; `onChange` fires only on real input
 * events, so an untouched field emits nothing and the parent leaves the stored
 * key alone. `type="password"` masks the value being entered.
 */
export function MaskedKeyInput({
  hasKey,
  value,
  onChange,
  disabled,
}: {
  hasKey: boolean;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const showStoredBullets = hasKey && value === "";
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: theme.muted, fontFamily: theme.mono }}>
        API key{" "}
        {hasKey && (
          <span style={{ color: theme.live }}>(a key is stored)</span>
        )}
      </span>
      <input
        type="password"
        value={value}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          showStoredBullets
            ? "••••••••••••••••  (paste a new key to replace)"
            : "sk_… — paste your ElevenLabs API key"
        }
        style={{
          padding: "10px 12px",
          borderRadius: 8,
          border: `1px solid ${theme.border}`,
          background: theme.surface,
          color: theme.fg,
          fontFamily: theme.mono,
          fontSize: 14,
        }}
      />
      <span style={{ fontSize: 11, color: theme.muted, fontFamily: theme.mono }}>
        Get a key at elevenlabs.io → Profile → API Keys. The stored key is never
        shown here.
      </span>
    </label>
  );
}
