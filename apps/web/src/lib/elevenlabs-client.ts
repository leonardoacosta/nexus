/**
 * Browser REST client for the Nexus agent's ElevenLabs credential endpoints.
 *
 * The `add-elevenlabs-credential` proposal specified this layer as Next.js
 * "server actions" under `apps/nextjs/src/app/actions/…`. That app does not
 * exist in this repo — `apps/web` is a client-rendered dashboard that talks to
 * the agent over REST via `NEXT_PUBLIC_NEXUS_AGENT_URL` (see
 * `agent-rest-client.ts`). This module is the faithful equivalent: plain
 * client-side fetchers, one per agent endpoint.
 *
 * Endpoints (`apps/agent/src/routes/elevenlabs-*.ts`) — NO per-request auth gate
 * (reach is bounded at the bind layer, loopback + Tailscale, after
 * `drop-attach-secret-gate`):
 *   GET    /elevenlabs/credentials       — masked status (never the raw key)
 *   PATCH  /elevenlabs/credentials       — partial upsert
 *   DELETE /elevenlabs/credentials       — drop the row
 *   POST   /elevenlabs/credentials/test  — probe /v1/user, persist outcome
 *   GET    /elevenlabs/voices            — proxied voice list (1h agent cache)
 *
 * Like the other web clients, this defines its OWN browser DTOs rather than
 * importing the `@nexus/core` Zod schemas — `apps/web` does not depend on the
 * server-only core package. The DTOs mirror `packages/core/src/types/elevenlabs.ts`.
 */

import { toHttpUrl } from "./agent-config";
import { AgentHttpError } from "./agent-rest-client";

// ── DTOs (mirror packages/core/src/types/elevenlabs.ts) ──────────────────────

/** Masked GET/PATCH response — never carries the raw key or ciphertext. */
export interface ElevenlabsCredentials {
  hasKey: boolean;
  voiceId: string | null;
  voiceName: string | null;
  lastTestOkAt: string | null;
  lastTestStatusCode: number | null;
  agentId: string;
}

/** PATCH body — only supplied fields are persisted (partial update). */
export interface ElevenlabsPatchInput {
  apiKey?: string;
  voiceId?: string;
  voiceName?: string;
}

export interface ElevenlabsSubscription {
  tier: string;
  characterCount: number;
  characterLimit: number;
  nextResetUnix: number;
}

/** POST /test response. `statusCode: null` => the probe threw (network error). */
export interface ElevenlabsTestResult {
  ok: boolean;
  statusCode: number | null;
  error?: string;
  subscription?: ElevenlabsSubscription;
}

export interface ElevenlabsVoice {
  voiceId: string;
  name: string;
  labels?: Record<string, string>;
}

// ── Transport ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;
/** POST /test proxies an upstream ElevenLabs call — allow a longer budget. */
const TEST_TIMEOUT_MS = 15_000;

function http(base: string, path: string): string {
  const url = toHttpUrl(base, path);
  if (!url) throw new AgentHttpError(0, `unconstructable agent URL for ${path}`);
  return url;
}

async function request(
  base: string,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetch(http(base, path), {
    ...rest,
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

async function expectJson<T>(res: Response, path: string): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      const err = (await res.json()) as { error?: string };
      detail = err.error ? `: ${err.error}` : "";
    } catch {
      // non-JSON error body
    }
    throw new AgentHttpError(res.status, `${path} -> ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

/** `GET /elevenlabs/credentials` — masked status for the local agent. */
export async function fetchCredentials(
  agentBaseUrl: string,
  signal?: AbortSignal,
): Promise<ElevenlabsCredentials> {
  const res = await request(agentBaseUrl, "/elevenlabs/credentials", {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  return expectJson<ElevenlabsCredentials>(res, "GET /elevenlabs/credentials");
}

/**
 * `PATCH /elevenlabs/credentials` — persist the supplied fields and return the
 * refreshed masked shape. Omit `apiKey` to update only the voice (the stored
 * key is left untouched).
 */
export async function saveCredentials(
  agentBaseUrl: string,
  input: ElevenlabsPatchInput,
  signal?: AbortSignal,
): Promise<ElevenlabsCredentials> {
  const res = await request(agentBaseUrl, "/elevenlabs/credentials", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  return expectJson<ElevenlabsCredentials>(res, "PATCH /elevenlabs/credentials");
}

/** `DELETE /elevenlabs/credentials` — drop the row (204, no body). */
export async function deleteCredentials(
  agentBaseUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await request(agentBaseUrl, "/elevenlabs/credentials", {
    method: "DELETE",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok && res.status !== 204) {
    throw new AgentHttpError(
      res.status,
      `DELETE /elevenlabs/credentials -> ${res.status}`,
    );
  }
}

/** `POST /elevenlabs/credentials/test` — probe /v1/user with the stored key. */
export async function testCredentials(
  agentBaseUrl: string,
  signal?: AbortSignal,
): Promise<ElevenlabsTestResult> {
  const res = await request(agentBaseUrl, "/elevenlabs/credentials/test", {
    method: "POST",
    headers: { Accept: "application/json" },
    timeoutMs: TEST_TIMEOUT_MS,
    signal,
  });
  return expectJson<ElevenlabsTestResult>(
    res,
    "POST /elevenlabs/credentials/test",
  );
}

/**
 * `GET /elevenlabs/voices` — proxied voice list (agent caches 1h). Returns the
 * `voices` array; the caller falls back to a free-text voice id on a 5xx.
 */
export async function listVoices(
  agentBaseUrl: string,
  signal?: AbortSignal,
): Promise<ElevenlabsVoice[]> {
  const res = await request(agentBaseUrl, "/elevenlabs/voices", {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = await expectJson<{ voices?: ElevenlabsVoice[] }>(
    res,
    "GET /elevenlabs/voices",
  );
  return Array.isArray(body.voices) ? body.voices : [];
}
