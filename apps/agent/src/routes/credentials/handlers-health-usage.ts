/**
 * Read-only observability handlers: health check and token usage.
 *
 * - GET /credentials/:id/health
 * - GET /credentials/:id/usage?window=1h|6h|24h|7d
 */

import type { Db } from "@nexus/db";
import {
  credentials as credentialsTable,
  sessionTokenTurns,
  eq,
  and,
  sql,
} from "@nexus/db";
import { gte } from "drizzle-orm";
import { fetchWithTimeout } from "@nexus/core/fetch";
import {
  emitAudit,
  extractCallerIp,
  jsonResponse,
  poolRef,
} from "./shared";

/**
 * GET /credentials/{id}/health — check if a credential is valid/revoked.
 *
 * Decrypts the credential, calls the Anthropic usage API, and returns
 * { healthy: boolean, checked_at: string }.
 */
export async function handleCredentialHealth(id: string, request: Request): Promise<Response> {
  const pool = poolRef.current;
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  // Use lease to get the decrypted credential value
  // We directly look up via internal pool mechanism
  const credential = await pool.getDecrypted(id);
  if (!credential) {
    return jsonResponse({ error: "credential not found" }, 404);
  }

  const checked_at = new Date().toISOString();
  const ip = extractCallerIp(request);
  try {
    const response = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential}`,
        "anthropic-version": "2023-06-01",
      },
      timeout: 10_000,
    });
    // 200 or 401/403 are both "valid credential" responses (credential reached the API)
    // true healthy = API accepts token; false = revoked/invalid
    const healthy = response.status !== 401 && response.status !== 403;

    emitAudit({
      event: "credential.health_check",
      credential_id: id,
      actor: "system",
      ip,
      timestamp_iso: checked_at,
      detail: { healthy, checked_at },
    });

    return jsonResponse({ healthy, checked_at });
  } catch {
    return jsonResponse({ error: "health check failed — could not reach Anthropic API" }, 500);
  }
}

// ── Valid window parameter values ──────────────────────────────────────────

const VALID_WINDOWS = ["1h", "6h", "24h", "7d"] as const;
type WindowParam = (typeof VALID_WINDOWS)[number];

/** Convert a window string to milliseconds. */
function windowToMs(window: WindowParam): number {
  switch (window) {
    case "1h":
      return 60 * 60 * 1000;
    case "6h":
      return 6 * 60 * 60 * 1000;
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
  }
}

/**
 * GET /credentials/{id}/usage?window=24h — aggregate token usage for a credential.
 *
 * Looks up the credential's fingerprint, aggregates session_token_turns
 * filtered by credential_fingerprint over the requested time window.
 * Returns token totals, cost, turn count, and distinct session count.
 */
export async function handleCredentialUsage(
  db: Db,
  id: string,
  request: Request,
): Promise<Response> {
  // Validate window parameter (task 7.3)
  const url = new URL(request.url);
  const windowParam = url.searchParams.get("window") ?? "24h";

  if (!VALID_WINDOWS.includes(windowParam as WindowParam)) {
    return jsonResponse(
      {
        error: "invalid window parameter",
        valid: [...VALID_WINDOWS],
      },
      400,
    );
  }

  const window = windowParam as WindowParam;

  // Look up the credential to get its fingerprint
  const credRows = await db
    .select({
      id: credentialsTable.id,
      fingerprint: credentialsTable.fingerprint,
    })
    .from(credentialsTable)
    .where(eq(credentialsTable.id, id))
    .limit(1);

  const credential = credRows[0];
  if (!credential) {
    return jsonResponse({ error: "credential not found" }, 404);
  }

  const fingerprint = credential.fingerprint;
  const windowStart = new Date(Date.now() - windowToMs(window));

  // Aggregate token turns by fingerprint within the window
  const rows = await db
    .select({
      input: sql<number>`COALESCE(SUM(${sessionTokenTurns.inputTokens}), 0)`,
      output: sql<number>`COALESCE(SUM(${sessionTokenTurns.outputTokens}), 0)`,
      cache_creation: sql<number>`COALESCE(SUM(${sessionTokenTurns.cacheCreationInputTokens}), 0)`,
      cache_read: sql<number>`COALESCE(SUM(${sessionTokenTurns.cacheReadInputTokens}), 0)`,
      cost_usd: sql<string | null>`SUM(${sessionTokenTurns.costUsd})`,
      turn_count: sql<number>`COUNT(*)`,
      session_count: sql<number>`COUNT(DISTINCT ${sessionTokenTurns.sessionId})`,
    })
    .from(sessionTokenTurns)
    .where(
      and(
        eq(sessionTokenTurns.credentialFingerprint, fingerprint),
        gte(sessionTokenTurns.ts, windowStart),
      ),
    );

  const agg = rows[0];
  const costUsd = agg?.cost_usd ? parseFloat(agg.cost_usd) : null;

  return jsonResponse({
    input: Number(agg?.input ?? 0),
    output: Number(agg?.output ?? 0),
    cache_creation: Number(agg?.cache_creation ?? 0),
    cache_read: Number(agg?.cache_read ?? 0),
    cost_usd: costUsd,
    turn_count: Number(agg?.turn_count ?? 0),
    session_count: Number(agg?.session_count ?? 0),
  });
}
