"use server";

/**
 * Server actions for the `/integrations/elevenlabs` dashboard page.
 *
 * Each action proxies to the local nexus-agent's `/elevenlabs/*` route group
 * (defined in `apps/agent/src/routes/elevenlabs-credentials.ts` &
 * `elevenlabs-voices.ts`). The agent owns the encryption key and the upstream
 * ElevenLabs HTTP calls — the dashboard never sees raw API keys, never talks
 * to api.elevenlabs.io directly, and runs zero validation logic that the
 * agent doesn't already enforce.
 *
 * Wire shapes are validated at runtime with the Zod schemas exported from
 * `@nexus/core` so a drift between agent and dashboard surfaces as an
 * actionable parse error rather than a silent type lie.
 *
 * Spec: openspec/changes/add-elevenlabs-credential/
 */

import {
  elevenlabsCredentialsResponse,
  elevenlabsTestResponse,
  elevenlabsVoicesResponse,
  type ElevenlabsCredentialsResponse,
  type ElevenlabsTestResponse,
  type ElevenlabsVoicesResponse,
} from "@nexus/core";
import { fetchWithTimeout } from "@nexus/core/fetch";
import { getAgentBaseUrl } from "@/lib/agent-url";

const REQUEST_TIMEOUT_MS = 5_000;
/** Test probe hits ElevenLabs from the agent — give it some headroom. */
const TEST_TIMEOUT_MS = 10_000;
/** Voice list proxies a third-party API; allow it slightly more than the default. */
const VOICES_TIMEOUT_MS = 8_000;

class AgentUnreachableError extends Error {
  constructor() {
    super("No reachable nexus-agent is configured");
    this.name = "AgentUnreachableError";
  }
}

function authHeaders(): Record<string, string> {
  return {
    "x-nexus-secret": process.env.NEXUS_ATTACH_SECRET ?? "",
    "Cache-Control": "no-store",
  };
}

async function resolveBaseUrl(): Promise<string> {
  const resolved = await getAgentBaseUrl();
  if (!resolved) throw new AgentUnreachableError();
  return resolved.baseUrl;
}

/**
 * GET /elevenlabs/credentials.
 *
 * Returns the masked credential shape — `hasKey` only, never the raw key.
 * On agent unreachable / non-2xx, throws so the page can render an error
 * banner instead of a confusingly empty form.
 */
export async function fetchCredentials(): Promise<ElevenlabsCredentialsResponse> {
  const baseUrl = await resolveBaseUrl();
  const res = await fetchWithTimeout(`${baseUrl}/elevenlabs/credentials`, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Agent returned ${res.status} for GET /elevenlabs/credentials`);
  }
  return elevenlabsCredentialsResponse.parse(await res.json());
}

/**
 * PATCH /elevenlabs/credentials.
 *
 * Only supplied fields are persisted (partial update). The agent encrypts
 * `apiKey` and stores `voiceId`/`voiceName` as plain text. Returns the
 * masked GET shape (post-write).
 */
export async function saveCredentials(input: {
  apiKey?: string;
  voiceId?: string;
  voiceName?: string;
}): Promise<ElevenlabsCredentialsResponse> {
  const baseUrl = await resolveBaseUrl();
  const res = await fetchWithTimeout(`${baseUrl}/elevenlabs/credentials`, {
    method: "PATCH",
    timeout: REQUEST_TIMEOUT_MS,
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Agent returned ${res.status} for PATCH /elevenlabs/credentials${
        text ? `: ${text}` : ""
      }`,
    );
  }
  return elevenlabsCredentialsResponse.parse(await res.json());
}

/**
 * POST /elevenlabs/credentials/test — probes the stored key against
 * ElevenLabs `/v1/user`. The agent persists the outcome on the row so the
 * page can surface "last tested" metadata after a refresh.
 */
export async function testCredentials(): Promise<ElevenlabsTestResponse> {
  const baseUrl = await resolveBaseUrl();
  const res = await fetchWithTimeout(`${baseUrl}/elevenlabs/credentials/test`, {
    method: "POST",
    timeout: TEST_TIMEOUT_MS,
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Agent returned ${res.status} for POST /elevenlabs/credentials/test`);
  }
  return elevenlabsTestResponse.parse(await res.json());
}

/**
 * DELETE /elevenlabs/credentials. After this returns the agent falls back
 * to `process.env.ELEVENLABS_API_KEY` (or signal-only if unset).
 */
export async function deleteCredentials(): Promise<void> {
  const baseUrl = await resolveBaseUrl();
  const res = await fetchWithTimeout(`${baseUrl}/elevenlabs/credentials`, {
    method: "DELETE",
    timeout: REQUEST_TIMEOUT_MS,
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Agent returned ${res.status} for DELETE /elevenlabs/credentials`);
  }
}

/**
 * GET /elevenlabs/voices — the agent caches the upstream response for 1h.
 *
 * On 5xx (or any failure) we degrade to an empty array so the dashboard can
 * fall back to a free-form text input. Throwing here would block the user
 * from saving a key in the failure case where ElevenLabs is down but their
 * key is fine.
 */
export async function listVoices(): Promise<ElevenlabsVoicesResponse> {
  try {
    const baseUrl = await resolveBaseUrl();
    const res = await fetchWithTimeout(`${baseUrl}/elevenlabs/voices`, {
      timeout: VOICES_TIMEOUT_MS,
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!res.ok) return { voices: [] };
    return elevenlabsVoicesResponse.parse(await res.json());
  } catch {
    return { voices: [] };
  }
}
