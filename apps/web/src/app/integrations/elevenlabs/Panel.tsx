"use client";

import { useEffect, useRef, useState } from "react";

import type {
  ElevenlabsCredentials,
  ElevenlabsTestResult,
} from "~/lib/elevenlabs-client";
import {
  deleteCredentials,
  fetchCredentials,
  saveCredentials,
  testCredentials,
} from "~/lib/elevenlabs-client";
import { theme } from "~/components/theme";

import { MaskedKeyInput } from "./MaskedKeyInput";
import { TestConnectionPanel } from "./TestConnectionPanel";
import { VoiceDropdown } from "./VoiceDropdown";

/**
 * ElevenLabs credential management panel (task 3.5). Composes the masked key
 * input, voice dropdown, and test-connection result, plus Save / Delete /
 * Test actions against the agent REST endpoints. Client component: fetches the
 * masked credential shape on mount and re-fetches after each mutation.
 *
 * State machine (state-handling skill): loading -> error -> data.
 */
export function ElevenLabsPanel({ agentBaseUrl }: { agentBaseUrl: string }) {
  const [creds, setCreds] = useState<ElevenlabsCredentials | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Draft form state. `keyDraft` empty => leave the stored key untouched.
  const [keyDraft, setKeyDraft] = useState("");
  const [voiceId, setVoiceId] = useState("");

  const [busy, setBusy] = useState<null | "save" | "delete" | "test">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ElevenlabsTestResult | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useRef((base: string) => {
    fetchCredentials(base)
      .then((c) => {
        if (!mounted.current) return;
        setCreds(c);
        setVoiceId(c.voiceId ?? "");
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!mounted.current) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load credentials");
      });
  });

  useEffect(() => {
    setCreds(null);
    load.current(agentBaseUrl);
  }, [agentBaseUrl]);

  const onSave = async () => {
    setBusy("save");
    setActionError(null);
    try {
      const input: { apiKey?: string; voiceId?: string } = {};
      if (keyDraft !== "") input.apiKey = keyDraft;
      // Persist the selected voice (empty string clears nothing — omit it).
      if (voiceId !== "") input.voiceId = voiceId;
      if (input.apiKey === undefined && input.voiceId === undefined) {
        setActionError("Nothing to save — enter a key or pick a voice.");
        setBusy(null);
        return;
      }
      const next = await saveCredentials(agentBaseUrl, input);
      if (!mounted.current) return;
      setCreds(next);
      setVoiceId(next.voiceId ?? "");
      setKeyDraft(""); // clear the draft; stored key is now masked
    } catch (err) {
      if (mounted.current) {
        setActionError(err instanceof Error ? err.message : "Save failed");
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const onTest = async () => {
    setBusy("test");
    setActionError(null);
    setTestResult(null);
    try {
      const result = await testCredentials(agentBaseUrl);
      if (!mounted.current) return;
      setTestResult(result);
      // Refresh so lastTestStatusCode / lastTestOkAt reflect the probe.
      load.current(agentBaseUrl);
    } catch (err) {
      if (mounted.current) {
        setActionError(err instanceof Error ? err.message : "Test failed");
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const onDelete = async () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm("Delete the stored ElevenLabs credential for this agent?")
    ) {
      return;
    }
    setBusy("delete");
    setActionError(null);
    try {
      await deleteCredentials(agentBaseUrl);
      if (!mounted.current) return;
      setKeyDraft("");
      setVoiceId("");
      setTestResult(null);
      load.current(agentBaseUrl);
    } catch (err) {
      if (mounted.current) {
        setActionError(err instanceof Error ? err.message : "Delete failed");
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  if (loadError && creds === null) {
    return (
      <Notice tone="closed">Could not load credentials: {loadError}</Notice>
    );
  }
  if (creds === null) {
    return (
      <div
        style={{
          height: 220,
          borderRadius: 8,
          border: `1px solid ${theme.border}`,
          background: theme.surface,
          opacity: 0.5,
        }}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <MaskedKeyInput
        hasKey={creds.hasKey}
        value={keyDraft}
        onChange={setKeyDraft}
        disabled={busy !== null}
      />

      <VoiceDropdown
        agentBaseUrl={agentBaseUrl}
        voiceId={voiceId}
        onChange={setVoiceId}
        disabled={busy !== null}
      />

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={busy !== null}
          style={primaryBtn(busy === "save")}
        >
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => void onTest()}
          disabled={busy !== null || !creds.hasKey}
          style={secondaryBtn}
          title={creds.hasKey ? undefined : "Save a key before testing"}
        >
          {busy === "test" ? "Testing…" : "Test connection"}
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void onDelete()}
          disabled={busy !== null || !creds.hasKey}
          style={dangerBtn}
        >
          {busy === "delete" ? "Deleting…" : "Delete credentials"}
        </button>
      </div>

      {actionError && (
        <p style={{ margin: 0, fontSize: 13, color: theme.closed, fontFamily: theme.mono }}>
          {actionError}
        </p>
      )}

      <TestConnectionPanel result={testResult} pending={busy === "test"} />

      {creds.lastTestStatusCode !== null && !testResult && (
        <p style={{ margin: 0, fontSize: 12, color: theme.muted, fontFamily: theme.mono }}>
          last test: status {creds.lastTestStatusCode}
          {creds.lastTestOkAt ? ` · ok at ${new Date(creds.lastTestOkAt).toLocaleString()}` : ""}
        </p>
      )}
    </div>
  );
}

function primaryBtn(active: boolean): React.CSSProperties {
  return {
    padding: "9px 18px",
    borderRadius: 8,
    border: `1px solid ${theme.accent}`,
    background: active ? theme.bg : theme.accent,
    color: active ? theme.accent : theme.bg,
    fontFamily: theme.mono,
    fontSize: 13,
    cursor: "pointer",
  };
}

const secondaryBtn: React.CSSProperties = {
  padding: "9px 18px",
  borderRadius: 8,
  border: `1px solid ${theme.border}`,
  background: "transparent",
  color: theme.fg,
  fontFamily: theme.mono,
  fontSize: 13,
  cursor: "pointer",
};

const dangerBtn: React.CSSProperties = {
  padding: "9px 18px",
  borderRadius: 8,
  border: `1px solid ${theme.closed}`,
  background: "transparent",
  color: theme.closed,
  fontFamily: theme.mono,
  fontSize: 13,
  cursor: "pointer",
};

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "muted" | "closed";
}) {
  return (
    <p
      style={{
        margin: 0,
        padding: "16px",
        borderRadius: 8,
        border: `1px dashed ${theme.border}`,
        background: theme.surface,
        color: tone === "closed" ? theme.closed : theme.muted,
        fontSize: 13,
        lineHeight: 1.5,
        fontFamily: theme.mono,
      }}
    >
      {children}
    </p>
  );
}
