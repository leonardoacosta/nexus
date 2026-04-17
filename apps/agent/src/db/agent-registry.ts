import type { Db } from "@nexus/db";
import { agents } from "@nexus/db";
import { expandTilde, getAgentId } from "@nexus/core";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

/** Resolve the local Tailscale IPv4 address, falling back to loopback. */
function getTailscaleIp(): string {
  try {
    return execSync("tailscale ip -4", { timeout: 2000, encoding: "utf8" }).trim();
  } catch {
    return "127.0.0.1";
  }
}

/**
 * Register (or refresh) this agent in the shared `agents` table.
 *
 * - On first insert: seeds all fields including name and projectsDir.
 * - On conflict (same hostname): updates only host, port, and lastSeen so
 *   that user-editable fields (name, projectsDir) are never overwritten.
 */
export async function upsertSelfInRegistry(db: Db): Promise<void> {
  // Identity is sourced from agents.toml (self_name → matched agent.name).
  // Falls back to os.hostname() when no config is present — preserves
  // backward compat for single-machine deploys that never set a config.
  const agentId = getAgentId();
  const host = getTailscaleIp();
  const port = parseInt(process.env.NEXUS_PORT ?? "7400", 10);
  const projectsDir = expandTilde(
    process.env.NEXUS_PROJECTS_DIR ?? path.join(os.homedir(), "dev"),
  );
  const lastSeen = new Date();

  await db
    .insert(agents)
    .values({
      id: agentId,
      name: agentId,
      host,
      port,
      projectsDir,
      enabled: true,
      lastSeen,
    })
    .onConflictDoUpdate({
      target: agents.id,
      set: { host, port, lastSeen },
    });
}
