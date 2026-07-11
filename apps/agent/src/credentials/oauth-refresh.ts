/**
 * Standalone OAuth refresh-grant helper for Claude Code credentials.
 *
 * Ported from `CcCredentialManager`'s private `callRefresh()`
 * (cc-credential-manager.ts) so `credential-refresh-job.ts` can call the
 * refresh grant without a `CcCredentialManager` instance — that class
 * requires a DB + a specific `credentials.json` path this job does not
 * touch (it refreshes pooled credentials, not the live CC session file).
 *
 * Two changes from the ported original:
 *
 * 1. **`client_id` is now included in the request body.** The original
 *    `callRefresh` omitted it, which Anthropic's OAuth grant requires — not
 *    present anywhere else in this codebase because nothing here previously
 *    implemented an authorization-code flow, only the refresh grant. The
 *    value below (`CC_OAUTH_CLIENT_ID`) is Claude Code's well-known, publicly
 *    documented OAuth client id (used by every third-party reimplementation
 *    of the CC OAuth flow — it is not a secret). Verified via public
 *    documentation, 2026-07-11.
 * 2. **Failure is typed** (`OAuthRefreshError.code`) so the caller can
 *    distinguish "this refresh token is permanently dead" (`invalid_grant`)
 *    from a transient network/5xx failure that should just retry next tick.
 *
 * The refresh-grant endpoint (`console.anthropic.com/v1/oauth/token`) is
 * reachable from this host — confirmed live via curl returning a real
 * Anthropic JSON error envelope (not a Cloudflare block page) when called
 * without required fields.
 */

const OAUTH_REFRESH_URL = "https://console.anthropic.com/v1/oauth/token";

/**
 * Claude Code's OAuth client id. Well-known / publicly documented (used by
 * every third-party reimplementation of the CC OAuth flow); not present
 * elsewhere in this codebase because nothing here previously implemented an
 * authorization-code flow, only the refresh grant.
 */
export const CC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export interface RefreshedToken {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
}

/**
 * Discriminates a permanently-dead refresh token from a transient failure.
 *
 * `"invalid_grant"` — the refresh token itself was rejected (revoked,
 * expired, or superseded by a later rotation elsewhere). The caller should
 * stop retrying and mark the credential dead.
 *
 * `"transient"` — network error, non-2xx that isn't an invalid_grant, or an
 * unparseable/incomplete response body. The caller should log and retry on
 * the next tick.
 */
export class OAuthRefreshError extends Error {
  readonly code: "invalid_grant" | "transient";

  constructor(code: "invalid_grant" | "transient", message: string) {
    super(message);
    this.name = "OAuthRefreshError";
    this.code = code;
  }
}

/**
 * Exchange a refresh token for a new access token via Anthropic's OAuth
 * refresh grant.
 *
 * @param refreshToken - the current (pre-rotation) refresh token
 * @param fetchImpl - override for tests; defaults to the global `fetch`
 *
 * @throws {OAuthRefreshError} `code: "invalid_grant"` when Anthropic reports
 *   the refresh token itself is dead, `code: "transient"` for every other
 *   failure mode (network error, other non-2xx, malformed response body).
 */
export async function refreshOAuthToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshedToken> {
  let resp: Response;
  try {
    resp = await fetchImpl(OAUTH_REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CC_OAUTH_CLIENT_ID,
      }),
    });
  } catch (err) {
    throw new OAuthRefreshError(
      "transient",
      `oauth refresh request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!resp.ok) {
    // Read the body as text (not .json()) so a non-JSON error page still
    // lets us classify the failure instead of throwing a secondary parse
    // error that masks the real status. The exact shape Anthropic uses for
    // an invalid_grant response on THIS endpoint is unconfirmed (only the
    // missing-fields 400 was verified live, which returned
    // `error.type: "invalid_request_error"`), so match defensively on the
    // substring rather than a specific JSON path.
    const rawBody = await resp.text().catch(() => "");
    const isInvalidGrant = resp.status === 400 && /invalid_grant/i.test(rawBody);
    if (isInvalidGrant) {
      throw new OAuthRefreshError(
        "invalid_grant",
        `refresh token rejected (invalid_grant): status=${resp.status}`,
      );
    }
    throw new OAuthRefreshError(
      "transient",
      `oauth refresh non-200: status=${resp.status} body=${rawBody.slice(0, 200)}`,
    );
  }

  let data: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  try {
    data = (await resp.json()) as typeof data;
  } catch (err) {
    throw new OAuthRefreshError(
      "transient",
      `oauth refresh response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (
    typeof data.access_token !== "string" ||
    typeof data.refresh_token !== "string" ||
    typeof data.expires_in !== "number"
  ) {
    throw new OAuthRefreshError(
      "transient",
      "oauth refresh response missing required fields",
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresInSec: data.expires_in,
  };
}
