/**
 * GET /presence/fleet — the dashboard's fleet-presence view
 * (openspec/changes/cross-machine-delivery, Phase 1.6).
 *
 * Returns the full `fleet_presence` snapshot, the resolved live-console machine
 * (newest-heartbeat-among-on-console within TTL, else local), and the local
 * machine name. The Swift `FleetPresenceIndicator` reads this to show "live
 * console: studio" / "notifications → this Mac".
 *
 * Reach is constrained at the bind layer (loopback + Tailscale), same as the
 * sibling dashboard GET routes — no per-handler secret check here.
 */

import type { Db } from "@nexus/db";
import { fleetPresence } from "@nexus/db";
import { createLogger, getAgentId } from "@nexus/core/node";
import {
  resolveLiveConsole,
  resolveLiveConsoleVector,
} from "../services/fleet-presence";

const log = createLogger("agent:routes:presence-fleet");

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleGetPresenceFleet(db: Db): Promise<Response> {
  const localMachine = getAgentId();
  const rows = await db.select().from(fleetPresence);
  const liveConsole = resolveLiveConsole(rows, localMachine);
  // Phase 1.7: include the resolved live-console machine's vector (or null when
  // none resolved) so the dashboard fleet indicator can show what the agent is
  // actually evaluating against (fleet-aware-rules-eval).
  const liveConsoleVector = resolveLiveConsoleVector(rows);

  log.debug(
    {
      localMachine,
      liveConsole,
      machines: rows.length,
      hasLiveConsoleVector: liveConsoleVector !== null,
    },
    "presence/fleet: resolved fleet view",
  );

  return jsonResponse({
    machines: rows,
    liveConsole,
    liveConsoleVector,
    localMachine,
  });
}
