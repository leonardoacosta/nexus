/**
 * Generic integration-credential routes.
 *
 * Dispatches off `PROVIDER_DESCRIPTORS` (`apps/agent/src/integrations/registry.ts`):
 * one row per `(agent_id, provider)` in `integration_credentials`, secret stored
 * AES-256-GCM in `valueEncrypted`, non-secret fields in the `metadata` JSONB.
 * Mirrors the masking / 400-on-missing-key / network-error discipline of
 * `routes/elevenlabs-credentials.ts` — the only structural difference is the
 * `:provider` path segment and the descriptor lookup.
 *
 * An unregistered provider is rejected with 404 BEFORE any DB access.
 *
 * Endpoints (no per-request auth gate; reach bounded at the bind layer —
 * loopback + Tailscale only):
 *   GET    /integrations/:provider/credentials       — masked status
 *   PATCH  /integrations/:provider/credentials       — partial upsert
 *   DELETE /integrations/:provider/credentials       — drops the row
 *   POST   /integrations/:provider/credentials/test  — probes upstream
 *   GET    /integrations/:provider/voices            — proxies the
 *     descriptor's optional `listVoices` (provider-qualified-project-voices)
 *
 * Spec: openspec/changes/add-integration-registry/, provider-qualified-project-voices/
 */

import { randomUUID } from "node:crypto";
import type { Db } from "@nexus/db";
import { integrationCredentials } from "@nexus/db";
import { logger, getAgentId } from "@nexus/core/node";
import { integrationPatchInput } from "@nexus/core";
import type { IntegrationCredentialsResponse } from "@nexus/core";
import { and, eq } from "drizzle-orm";

import { PROVIDER_DESCRIPTORS } from "../integrations/registry";
import { decrypt, encrypt, tryLoadEncryptionKey } from "../credentials/encryption";
import { withCors } from "../server-origin";

// ── Response helpers ───────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build the masked GET shape from a row. The ONLY function that reads
 * `valueEncrypted`; callers never see it. `hasSecret` is the entire
 * existence-bit signal — no preview, no last-N-chars.
 */
function toResponseShape(
  provider: string,
  agentId: string,
  row: typeof integrationCredentials.$inferSelect | null,
): IntegrationCredentialsResponse {
  if (!row) {
    return {
      provider,
      hasSecret: false,
      metadata: {},
      lastTestOkAt: null,
      lastTestStatusCode: null,
      agentId,
    };
  }
  return {
    provider,
    hasSecret: row.valueEncrypted !== null && row.valueEncrypted !== "",
    metadata: row.metadata ?? {},
    lastTestOkAt: row.lastTestOkAt ? row.lastTestOkAt.toISOString() : null,
    lastTestStatusCode: row.lastTestStatusCode,
    agentId,
  };
}

/** Locate the single row for this agent + provider. */
function findRow(db: Db, agentId: string, provider: string) {
  return db.query.integrationCredentials.findFirst({
    where: and(
      eq(integrationCredentials.agentId, agentId),
      eq(integrationCredentials.provider, provider),
    ),
  });
}

// ── Handlers ───────────────────────────────────────────────────────────────

/** GET /integrations/:provider/credentials — masked shape. */
export async function handleGetCredentials(
  db: Db,
  _request: Request,
  provider: string,
): Promise<Response> {
  if (!PROVIDER_DESCRIPTORS[provider]) {
    return jsonResponse({ error: "unknown provider" }, 404);
  }
  const agentId = getAgentId();
  const row = await findRow(db, agentId, provider);
  return jsonResponse(toResponseShape(provider, agentId, row ?? null));
}

/** PATCH /integrations/:provider/credentials — partial upsert. */
export async function handlePatchCredentials(
  db: Db,
  request: Request,
  provider: string,
): Promise<Response> {
  const descriptor = PROVIDER_DESCRIPTORS[provider];
  if (!descriptor) {
    return jsonResponse({ error: "unknown provider" }, 404);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }

  const parsed = integrationPatchInput.safeParse(rawBody);
  if (!parsed.success) {
    return jsonResponse(
      { error: "invalid input", detail: parsed.error.issues },
      400,
    );
  }

  const { secret, metadata } = parsed.data;
  if (secret === undefined && metadata === undefined) {
    return jsonResponse({ error: "no fields supplied" }, 400);
  }

  // Validate metadata against the provider schema BEFORE any write.
  if (metadata !== undefined) {
    const metaParsed = descriptor.metadataSchema.safeParse(metadata);
    if (!metaParsed.success) {
      return jsonResponse(
        { error: "invalid metadata", detail: metaParsed.error.issues },
        400,
      );
    }
  }

  // Only resolve the encryption key when a secret is actually being written.
  let key: Buffer | null = null;
  if (secret !== undefined) {
    key = tryLoadEncryptionKey();
    if (!key) {
      return jsonResponse({ error: "encryption key not configured" }, 400);
    }
  }

  const agentId = getAgentId();
  const existing = await findRow(db, agentId, provider);

  if (existing) {
    const update: Partial<typeof integrationCredentials.$inferInsert> = {};
    if (secret !== undefined && key) update.valueEncrypted = encrypt(secret, key);
    if (metadata !== undefined) update.metadata = metadata;
    await db
      .update(integrationCredentials)
      .set(update)
      .where(
        and(
          eq(integrationCredentials.agentId, agentId),
          eq(integrationCredentials.provider, provider),
        ),
      );
  } else {
    await db.insert(integrationCredentials).values({
      id: randomUUID(),
      provider,
      agentId,
      valueEncrypted: secret !== undefined && key ? encrypt(secret, key) : null,
      metadata: metadata ?? {},
    });
  }

  const refreshed = await findRow(db, agentId, provider);
  return jsonResponse(toResponseShape(provider, agentId, refreshed ?? null));
}

/** DELETE /integrations/:provider/credentials — drop the row. */
export async function handleDeleteCredentials(
  db: Db,
  _request: Request,
  provider: string,
): Promise<Response> {
  if (!PROVIDER_DESCRIPTORS[provider]) {
    return jsonResponse({ error: "unknown provider" }, 404);
  }
  const agentId = getAgentId();
  await db
    .delete(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.agentId, agentId),
        eq(integrationCredentials.provider, provider),
      ),
    );
  return new Response(null, { status: 204 });
}

/**
 * POST /integrations/:provider/credentials/test — probe upstream with the
 * stored secret. Persists `last_test_status_code` always, `last_test_ok_at`
 * only when `ok`. The descriptor's `testProbe` never throws, so network
 * failures surface as `{ ok: false, statusCode: null }`.
 *
 * `requiresSecret === false` (e.g. kokoro) skips the `value_encrypted`/decrypt
 * gate entirely — the 404-unknown-provider and 400-no-row semantics are
 * unchanged, but the row only needs to exist (any metadata), never a secret.
 * `testProbe` is invoked with an empty-string secret it's documented to
 * ignore. Secret-requiring providers (the default — `requiresSecret`
 * undefined or `true`) keep the exact prior behavior below.
 */
export async function handleTestConnection(
  db: Db,
  _request: Request,
  provider: string,
): Promise<Response> {
  const descriptor = PROVIDER_DESCRIPTORS[provider];
  if (!descriptor) {
    return jsonResponse({ error: "unknown provider" }, 404);
  }

  const agentId = getAgentId();
  const row = await findRow(db, agentId, provider);

  if (descriptor.requiresSecret === false) {
    if (!row) {
      return jsonResponse({ error: "no credential stored" }, 400);
    }
    const { ok, statusCode } = await descriptor.testProbe("", row.metadata ?? {});
    await db
      .update(integrationCredentials)
      .set({
        lastTestStatusCode: statusCode,
        ...(ok ? { lastTestOkAt: new Date() } : {}),
      })
      .where(
        and(
          eq(integrationCredentials.agentId, agentId),
          eq(integrationCredentials.provider, provider),
        ),
      );
    return jsonResponse({ ok, statusCode });
  }

  if (!row || !row.valueEncrypted) {
    return jsonResponse({ error: "no credential stored" }, 400);
  }

  const key = tryLoadEncryptionKey();
  if (!key) {
    return jsonResponse({ error: "encryption key not configured" }, 400);
  }

  let secret: string;
  try {
    secret = decrypt(row.valueEncrypted, key);
  } catch (err) {
    logger.error(
      { err, agentId, provider },
      "integration: failed to decrypt stored secret",
    );
    return jsonResponse({ error: "could not decrypt stored credential" }, 500);
  }

  const { ok, statusCode } = await descriptor.testProbe(
    secret,
    row.metadata ?? {},
  );

  await db
    .update(integrationCredentials)
    .set({
      lastTestStatusCode: statusCode,
      ...(ok ? { lastTestOkAt: new Date() } : {}),
    })
    .where(
      and(
        eq(integrationCredentials.agentId, agentId),
        eq(integrationCredentials.provider, provider),
      ),
    );

  return jsonResponse({ ok, statusCode });
}

/**
 * GET /integrations/:provider/voices — generic voice-listing proxy
 * (provider-qualified-project-voices). Dispatches off the descriptor's
 * optional `listVoices`; a descriptor without it 404s before any DB access.
 * Mirrors `handleTestConnection`'s secret-gating: `requiresSecret === false`
 * (kokoro) skips the decrypt gate, secret-requiring providers keep the
 * decrypt-then-call shape. Either way, no stored row is 400 — the descriptor
 * needs its metadata (or secret) to probe anything.
 */
export async function handleListProviderVoices(
  db: Db,
  _request: Request,
  provider: string,
): Promise<Response> {
  const descriptor = PROVIDER_DESCRIPTORS[provider];
  if (!descriptor || !descriptor.listVoices) {
    return jsonResponse({ error: "unknown provider" }, 404);
  }

  const agentId = getAgentId();
  const row = await findRow(db, agentId, provider);
  if (!row) {
    return jsonResponse({ error: "no credential stored" }, 400);
  }

  if (descriptor.requiresSecret === false) {
    const { ok, statusCode, voices } = await descriptor.listVoices(
      "",
      row.metadata ?? {},
    );
    return jsonResponse({ ok, statusCode, voices });
  }

  if (!row.valueEncrypted) {
    return jsonResponse({ error: "no credential stored" }, 400);
  }

  const key = tryLoadEncryptionKey();
  if (!key) {
    return jsonResponse({ error: "encryption key not configured" }, 400);
  }

  let secret: string;
  try {
    secret = decrypt(row.valueEncrypted, key);
  } catch (err) {
    logger.error(
      { err, agentId, provider },
      "integration: failed to decrypt stored secret",
    );
    return jsonResponse({ error: "could not decrypt stored credential" }, 500);
  }

  const { ok, statusCode, voices } = await descriptor.listVoices(
    secret,
    row.metadata ?? {},
  );
  return jsonResponse({ ok, statusCode, voices });
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Match and handle a generic integration-credential route.
 *
 * Parses the `:provider` path segment from
 * `/integrations/:provider/credentials[/test]` or
 * `/integrations/:provider/voices` and delegates to the handler for the
 * method. Returns a Response when the URL matches, or `null` when it does
 * not (callers fall through). Without a Db no route can run — returns
 * `null` so the outer dispatcher hits the not-found branch rather than 500-ing.
 */
export function tryHandleIntegrationCredentialsRoute(
  request: Request,
  url: URL,
  db?: Db,
): Response | Promise<Response> | null {
  if (!db) return null;

  // ["", "integrations", ":provider", "credentials"|"voices", ...("test")]
  const segments = url.pathname.split("/");
  if (segments[1] !== "integrations") return null;
  const provider = segments[2];
  if (!provider) return null;
  const subpath = segments[3];

  const wrap = (
    p: Promise<Response>,
    route: string,
    method: string,
  ): Promise<Response> =>
    p.then((r) => withCors(request, r)).catch((err) => {
      logger.error({ route, method, err }, "route handler failed");
      return withCors(
        request,
        new Response(JSON.stringify({ error: "internal error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

  if (subpath === "voices" && segments.length === 4) {
    if (request.method !== "GET") return null;
    return wrap(
      handleListProviderVoices(db, request, provider),
      `/integrations/${provider}/voices`,
      "GET",
    );
  }

  if (subpath !== "credentials") return null;

  const isTest = segments[4] === "test" && segments.length === 5;
  const isBase = segments.length === 4;
  if (!isBase && !isTest) return null;

  const route = `/integrations/${provider}/credentials${isTest ? "/test" : ""}`;

  if (isBase && request.method === "GET") {
    return wrap(handleGetCredentials(db, request, provider), route, "GET");
  }
  if (isBase && request.method === "PATCH") {
    return wrap(handlePatchCredentials(db, request, provider), route, "PATCH");
  }
  if (isBase && request.method === "DELETE") {
    return wrap(handleDeleteCredentials(db, request, provider), route, "DELETE");
  }
  if (isTest && request.method === "POST") {
    return wrap(handleTestConnection(db, request, provider), route, "POST");
  }

  return null;
}
