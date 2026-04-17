import type { Db } from "@nexus/db";
import { agents } from "@nexus/db";
import { getAgentId } from "@nexus/core";
import { eq } from "drizzle-orm";

/** GET /agent — return the agent row for this machine, 404 if not registered. */
export async function handleGetAgentSelf(db: Db): Promise<Response> {
  const rows = await db.select().from(agents).where(eq(agents.id, getAgentId()));

  if (rows.length === 0) {
    return new Response(
      JSON.stringify({ error: "Agent not registered" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify(rows[0]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
