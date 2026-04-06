import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/ws-token
 *
 * Returns the NEXUS_ATTACH_SECRET to the browser so XTerminal can append it
 * as a `?token=` query-string parameter on WebSocket upgrade requests.
 *
 * Browsers cannot set custom HTTP headers during WebSocket upgrades, so we
 * expose the secret through this server-side route instead of embedding it
 * in static client bundles.
 *
 * The response is intentionally not cached (force-dynamic) and should only
 * be served over Tailscale (the agent's network boundary).
 */
export async function GET(): Promise<NextResponse> {
  const secret = process.env.NEXUS_ATTACH_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "NEXUS_ATTACH_SECRET is not configured" },
      { status: 503 },
    );
  }
  return NextResponse.json({ token: secret });
}
