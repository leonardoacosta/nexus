"use client";

import { useEffect, useRef, useState } from "react";

import type {
  IntegrationCredentialsResponse,
  IntegrationTestResult,
} from "~/lib/integration-client";
import {
  deleteIntegrationCredentials,
  getIntegrationCredentials,
  patchIntegrationCredentials,
  testIntegrationConnection,
} from "~/lib/integration-client";
import { theme } from "~/components/theme";

import { MaskedKeyInput } from "../elevenlabs/MaskedKeyInput";

const PROVIDER = "telegram";

/**
 * Telegram credential-management panel. Mirrors the ElevenLabs `Panel.tsx`
 * state machine (loading -> error -> data; re-fetch after every mutation) but
 * simpler: a masked bot token (reusing the shared {@link MaskedKeyInput}) plus a
 * plain controlled `chatId` stored in `metadata.chatId`. Save / Test / Delete
 * wire to `integration-client.ts` with `provider="telegram"`.
 */
export function TelegramPanel({ agentBaseUrl }: { agentBaseUrl: string }) {
  const [creds, setCreds] = useState<IntegrationCredentialsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Draft form state. `tokenDraft` empty => leave the stored secret untouched.
  const [tokenDraft, setTokenDraft] = useState("");
  const [chatId, setChatId] = useState("");

  const [busy, setBusy] = useState<null | "save" | "delete" | "test">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useRef((base: string) => {
    getIntegrationCredentials(base, PROVIDER)
      .then((c) => {
        if (!mounted.current) return;
        setCreds(c);
        setChatId(typeof c.metadata.chatId === "string" ? c.metadata.chatId : "");
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!mounted.current) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load credentials",
        );
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
      const body: { secret?: string; metadata?: Record<string, unknown> } = {};
      if (tokenDraft !== "") body.secret = tokenDraft;
      if (chatId !== "") body.metadata = { chatId };
      if (body.secret === undefined && body.metadata === undefined) {
        setActionError("Nothing to save — enter a bot token or chat id.");
        setBusy(null);
        return;
      }
      const next = await patchIntegrationCredentials(agentBaseUrl, PROVIDER, body);
      if (!mounted.current) return;
      setCreds(next);
      setChatId(
        typeof next.metadata.chatId === "string" ? next.metadata.chatId : "",
      );
      setTokenDraft(""); // clear the draft; stored token is now masked
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
      const result = await testIntegrationConnection(agentBaseUrl, PROVIDER);
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
      !window.confirm("Delete the stored Telegram credential for this agent?")
    ) {
      return;
    }
    setBusy("delete");
    setActionError(null);
    try {
      await deleteIntegrationCredentials(agentBaseUrl, PROVIDER);
      if (!mounted.current) return;
      setTokenDraft("");
      setChatId("");
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
    return <Notice tone="closed">Could not load credentials: {loadError}</Notice>;
  }
  if (creds === null) {
    return (
      <div
        style={{
          height: 200,
          borderRadius: 8,
          border: `1px solid ${theme.border}`,
          background: theme.surface,
          opacity: 0.5,
        }}
      />
    );
  }

  const canTest = creds.hasSecret && chatId.trim() !== "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <MaskedKeyInput
        hasKey={creds.hasSecret}
        value={tokenDraft}
        onChange={setTokenDraft}
        disabled={busy !== null}
      />

      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, color: theme.muted, fontFamily: theme.mono }}>
          Chat ID
        </span>
        <input
          type="text"
          value={chatId}
          disabled={busy !== null}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setChatId(e.target.value)}
          placeholder="e.g. 123456789 or -1001234567890"
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
          The chat/channel the bot posts to. Message the bot (or add it to the
          channel) first, then read the id from getUpdates.
        </span>
      </label>

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
          disabled={busy !== null || !canTest}
          style={secondaryBtn}
          title={
            canTest ? undefined : "Save a bot token and chat id before testing"
          }
        >
          {busy === "test" ? "Testing…" : "Test connection"}
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void onDelete()}
          disabled={busy !== null || !creds.hasSecret}
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

      {(testResult || busy === "test") && (
        <TestStatus result={testResult} pending={busy === "test"} />
      )}

      {creds.lastTestStatusCode !== null && !testResult && busy !== "test" && (
        <p style={{ margin: 0, fontSize: 12, color: theme.muted, fontFamily: theme.mono }}>
          last test: status {creds.lastTestStatusCode}
          {creds.lastTestOkAt
            ? ` · ok at ${new Date(creds.lastTestOkAt).toLocaleString()}`
            : ""}
        </p>
      )}
    </div>
  );
}

function TestStatus({
  result,
  pending,
}: {
  result: IntegrationTestResult | null;
  pending: boolean;
}) {
  if (pending) {
    return <div style={{ ...boxStyle, color: theme.muted }}>Testing connection…</div>;
  }
  if (!result) return null;

  const tone = result.ok ? theme.live : theme.closed;
  const label =
    result.statusCode === null
      ? "Network error — could not reach the Telegram API"
      : result.ok
        ? `Status: ${result.statusCode} — OK`
        : `Status: ${result.statusCode} — request rejected`;

  return (
    <div style={{ ...boxStyle, borderColor: tone }}>
      <p style={{ margin: 0, color: tone, fontSize: 13 }}>{label}</p>
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

const boxStyle: React.CSSProperties = {
  margin: 0,
  padding: "12px 14px",
  borderRadius: 8,
  border: `1px solid ${theme.border}`,
  background: theme.surface,
  fontFamily: theme.mono,
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
