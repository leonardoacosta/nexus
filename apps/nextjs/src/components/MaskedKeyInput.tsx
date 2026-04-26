"use client";

import { useState } from "react";

/**
 * Masked-input field for an API key.
 *
 * Tri-state semantics:
 *
 *   1. `hasKey === true` and the user hasn't touched the field
 *      → render a bullet placeholder, internal value is empty.
 *      `onChange(undefined)` already fired during the initial render is NOT
 *      sent — callers default the draft state to `undefined` themselves.
 *
 *   2. The user types anything
 *      → mask falls away, the typed value flows through `onChange(value)`.
 *
 *   3. The user clears the field after typing
 *      → `onChange(undefined)` so the caller knows "no change requested",
 *      distinct from the empty-string sentinel which would mean "clear the
 *      stored key" (the API uses DELETE for that — there's no empty-string
 *      patch path).
 *
 * The stored key is NEVER displayed; the placeholder is decorative only.
 */
export interface MaskedKeyInputProps {
  hasKey: boolean;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  /** Optional id to wire up an external `<label htmlFor={...}>`. */
  id?: string;
}

export function MaskedKeyInput({
  hasKey,
  onChange,
  placeholder,
  id,
}: MaskedKeyInputProps) {
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);

  // While untouched and the agent reports a key, render decorative bullets.
  // Once the user types, switch to their value (which can be empty after
  // backspacing back to nothing — that's the "no change" state).
  const showMask = hasKey && !touched;
  const renderedPlaceholder = showMask
    ? "••••••••••••"
    : (placeholder ?? "Paste your ElevenLabs API key");

  return (
    <input
      id={id}
      type="password"
      autoComplete="off"
      spellCheck={false}
      value={value}
      placeholder={renderedPlaceholder}
      data-testid="elevenlabs-api-key-input"
      onChange={(e) => {
        const next = e.target.value;
        setValue(next);
        if (!touched) setTouched(true);
        if (next === "") {
          // After typing then clearing — treat as "no change" so we don't
          // accidentally tell the API to wipe the stored key.
          onChange(undefined);
        } else {
          onChange(next);
        }
      }}
      style={{
        width: "100%",
        padding: "var(--space-2) var(--space-3)",
        fontSize: "var(--font-size-sm)",
        fontFamily: "var(--font-mono)",
        background: "var(--color-surface-raised)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        color: "var(--color-fg)",
        outline: "none",
      }}
    />
  );
}
