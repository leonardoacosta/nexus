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

const PROVIDER = "kokoro";

/**
 * Kokoro credential-management panel. Mirrors the `TelegramPanel` state
 * machine (loading -> error -> data; re-fetch after every mutation) but is
 * fully secretless — `requiresSecret: false` on the agent's `kokoro`
 * descriptor (see `apps/agent/src/integrations/registry.ts`), so there is no
 * `MaskedKeyInput` and no bot-token draft. Both fields are plain controlled
 * inputs persisted to `metadata`: a required self-hosted `baseUrl` and an
 * optional `defaultVoice`. Save / Test / Delete wire to `integration-client.ts`
 * with `provider="kokoro"`.
 */
export function KokoroPanel({ agentBaseUrl }: { agentBaseUrl: string }) {
  const [creds, setCreds] = useState<IntegrationCredentialsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [baseUrl, setBaseUrl] = useState("");
  const [defaultVoice, setDefaultVoice] = useState("");

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
        setBaseUrl(typeof c.metadata.baseUrl === "string" ? c.metadata.baseUrl : "");
        setDefaultVoice(
          typeof c.metadata.defaultVoice === "string" ? c.metadata.defaultVoice : "",
        );
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
      if (baseUrl.trim() === "") {
        setActionError("Nothing to save — enter a base URL.");
        setBusy(null);
        return;
      }
      const metadata: Record<string, unknown> = { baseUrl: baseUrl.trim() };
      if (defaultVoice.trim() !== "") metadata.defaultVoice = defaultVoice.trim();
      const next = await patchIntegrationCredentials(agentBaseUrl, PROVIDER, {
        metadata,
      });
      if (!mounted.current) return;
      setCreds(next);
      setBaseUrl(
        typeof next.metadata.baseUrl === "string" ? next.metadata.baseUrl : "",
      );
      setDefaultVoice(
        typeof next.metadata.defaultVoice === "string"
          ? next.metadata.defaultVoice
          : "",
      );
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
      !window.confirm("Delete the stored Kokoro credential for this agent?")
    ) {
      return;
    }
    setBusy("delete");
    setActionError(null);
    try {
      await deleteIntegrationCredentials(agentBaseUrl, PROVIDER);
      if (!mounted.current) return;
      setBaseUrl("");
      setDefaultVoice("");
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

  // Kokoro is secretless (requiresSecret: false) — a stored row is signaled by
  // a persisted baseUrl in metadata, not `hasSecret` (which is always false).
  const hasRow = typeof creds.metadata.baseUrl === "string" && creds.metadata.baseUrl !== "";
  const canTest = hasRow;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, color: theme.muted, fontFamily: theme.mono }}>
          Base URL
        </span>
        <input
          type="text"
          value={baseUrl}
          disabled={busy !== null}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="e.g. http://100.73.182.4:8880"
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
          The self-hosted Kokoro FastAPI base URL (Tailscale-only, no public
          bind). No API key required.
        </span>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, color: theme.muted, fontFamily: theme.mono }}>
          Default voice (optional)
        </span>
        <input
          type="text"
          value={defaultVoice}
          disabled={busy !== null}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDefaultVoice(e.target.value)}
          placeholder="e.g. af_heart"
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
          title={canTest ? undefined : "Save a base URL before testing"}
        >
          {busy === "test" ? "Testing…" : "Test connection"}
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void onDelete()}
          disabled={busy !== null || !hasRow}
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
      ? "Network error — could not reach the Kokoro server"
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
