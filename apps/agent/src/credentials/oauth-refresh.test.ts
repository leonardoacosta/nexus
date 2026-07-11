/**
 * Unit tests for oauth-refresh.ts.
 *
 * Spec: fix-credential-usage-poller-100pct-failure
 *
 * Covers: successful refresh (incl. that `client_id` is sent — the bug fixed
 * relative to the ported `cc-credential-manager.callRefresh`), invalid_grant
 * classification, and the transient-failure fallback for every other error
 * shape (non-200 without invalid_grant, network throw, malformed body,
 * incomplete body).
 */

import { describe, expect, it } from "bun:test";
import { refreshOAuthToken, OAuthRefreshError, CC_OAUTH_CLIENT_ID } from "./oauth-refresh";

function fakeFetch(responder: (input: unknown, init: RequestInit) => Response): typeof fetch {
  return (async (input: unknown, init?: RequestInit) =>
    responder(input, init ?? {})) as unknown as typeof fetch;
}

describe("refreshOAuthToken", () => {
  it("sends client_id in the request body and returns the new token material", async () => {
    let sentBody: Record<string, unknown> | null = null;
    const fetchImpl = fakeFetch((_input, init) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await refreshOAuthToken("old-refresh", fetchImpl);

    expect(sentBody).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
      client_id: CC_OAUTH_CLIENT_ID,
    });
    expect(result).toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresInSec: 3600,
    });
  });

  it("classifies a 400 invalid_grant response as OAuthRefreshError(invalid_grant)", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_grant", message: "Refresh token is invalid" },
          }),
          { status: 400 },
        ),
    );

    const err = await refreshOAuthToken("dead-refresh", fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthRefreshError);
    expect((err as OAuthRefreshError).code).toBe("invalid_grant");
  });

  it("classifies a 400 WITHOUT invalid_grant as transient (matches the verified missing-fields shape)", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "missing client_id" },
          }),
          { status: 400 },
        ),
    );

    const err = await refreshOAuthToken("some-refresh", fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthRefreshError);
    expect((err as OAuthRefreshError).code).toBe("transient");
  });

  it("classifies a 5xx response as transient", async () => {
    const fetchImpl = fakeFetch(() => new Response("upstream down", { status: 503 }));
    const err = await refreshOAuthToken("some-refresh", fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthRefreshError);
    expect((err as OAuthRefreshError).code).toBe("transient");
  });

  it("classifies a network error (fetch throws) as transient", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const err = await refreshOAuthToken("some-refresh", fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthRefreshError);
    expect((err as OAuthRefreshError).code).toBe("transient");
  });

  it("classifies a non-JSON 200 body as transient", async () => {
    const fetchImpl = fakeFetch(() => new Response("not json", { status: 200 }));
    const err = await refreshOAuthToken("some-refresh", fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthRefreshError);
    expect((err as OAuthRefreshError).code).toBe("transient");
  });

  it("classifies a 200 body missing required fields as transient", async () => {
    const fetchImpl = fakeFetch(
      () => new Response(JSON.stringify({ access_token: "only-this" }), { status: 200 }),
    );
    const err = await refreshOAuthToken("some-refresh", fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthRefreshError);
    expect((err as OAuthRefreshError).code).toBe("transient");
  });
});
