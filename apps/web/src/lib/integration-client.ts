/**
 * Browser REST client for the Nexus agent's generic integration-credential
 * endpoints — one client, parameterized by `provider`.
 *
 * Mirrors `elevenlabs-client.ts` exactly in shape, error-handling, and base-URL
 * resolution; the only difference is the `:provider` path segment. The agent
 * side (`apps/agent/src/routes/integration-credentials.ts`) dispatches every
 * provider off `PROVIDER_DESCRIPTORS`.
 *
 * Endpoints (`/integrations/:provider/credentials*`) — NO per-request auth gate
 * (reach bounded at the bind layer, loopback + Tailscale):
 *   GET    /integrations/:provider/credentials       — masked status
 *   PATCH  /integrations/:provider/credentials       — partial upsert
 *   DELETE /integrations/:provider/credentials       — drop the row
 *   POST   /integrations/:provider/credentials/test  — probe upstream
 *
 * Like the other web clients, this defines its OWN browser DTOs rather than
 * importing the `@nexus/core` Zod schemas — `apps/web` does not depend on the
 * server-only core package (it would pull Drizzle/zod into the browser bundle;
 * see `elevenlabs-client.ts` / `agent-radar-client.ts`). The DTOs mirror
 * `packages/core/src/types/integrations.ts`.
 */

import { toHttpUrl } from "./agent-config";
import { AgentHttpError } from "./agent-rest-client";

// ── DTOs (mirror packages/core/src/types/integrations.ts) ────────────────────

/** Masked GET/PATCH response — never carries the raw secret or ciphertext. */
export interface IntegrationCredentialsResponse {
  provider: string;
  hasSecret: boolean;
  metadata: Record<string, unknown>;
  lastTestOkAt: string | null;
  lastTestStatusCode: number | null;
  agentId: string;
}

/** PATCH body — only supplied fields are persisted (partial update). */
export interface IntegrationPatchInput {
  secret?: string;
  metadata?: Record<string, unknown>;
}

/** POST /test response. `statusCode: null` => the probe threw (network error). */
export interface IntegrationTestResult {
  ok: boolean;
  statusCode: number | null;
}

// ── Transport ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;
/** POST /test proxies an upstream provider call — allow a longer budget. */
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

/** `GET /integrations/:provider/credentials` — masked status. */
export async function getIntegrationCredentials(
  agentBaseUrl: string,
  provider: string,
  signal?: AbortSignal,
): Promise<IntegrationCredentialsResponse> {
  const path = `/integrations/${provider}/credentials`;
  const res = await request(agentBaseUrl, path, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  return expectJson<IntegrationCredentialsResponse>(res, `GET ${path}`);
}

/**
 * `PATCH /integrations/:provider/credentials` — persist the supplied fields and
 * return the refreshed masked shape. Omit `secret` to update only metadata (the
 * stored secret is left untouched).
 */
export async function patchIntegrationCredentials(
  agentBaseUrl: string,
  provider: string,
  body: IntegrationPatchInput,
  signal?: AbortSignal,
): Promise<IntegrationCredentialsResponse> {
  const path = `/integrations/${provider}/credentials`;
  const res = await request(agentBaseUrl, path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return expectJson<IntegrationCredentialsResponse>(res, `PATCH ${path}`);
}

/** `DELETE /integrations/:provider/credentials` — drop the row (204, no body). */
export async function deleteIntegrationCredentials(
  agentBaseUrl: string,
  provider: string,
  signal?: AbortSignal,
): Promise<void> {
  const path = `/integrations/${provider}/credentials`;
  const res = await request(agentBaseUrl, path, {
    method: "DELETE",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok && res.status !== 204) {
    throw new AgentHttpError(
      res.status,
      `DELETE ${path} -> ${res.status}`, // SAFE: HTTP route in an error message, not SQL
    );
  }
}

/**
 * `POST /integrations/:provider/credentials/test` — probe upstream with the
 * stored secret. Returns `{ ok, statusCode }`; `statusCode: null` means the
 * probe threw before any HTTP exchange (network error).
 */
export async function testIntegrationConnection(
  agentBaseUrl: string,
  provider: string,
  signal?: AbortSignal,
): Promise<IntegrationTestResult> {
  const path = `/integrations/${provider}/credentials/test`;
  const res = await request(agentBaseUrl, path, {
    method: "POST",
    headers: { Accept: "application/json" },
    timeoutMs: TEST_TIMEOUT_MS,
    signal,
  });
  return expectJson<IntegrationTestResult>(res, `POST ${path}`);
}
