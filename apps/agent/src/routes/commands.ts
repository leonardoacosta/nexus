/**
 * Command registry routes — list, filter, update.
 *
 * Mirrors the Rust agent's command handlers. Uses the CommandRegistry
 * service for in-memory command lookup and filesystem writes for updates.
 */

import { createLogger } from "@nexus/core";
import { CommandRegistry } from "../services/command-registry";

const log = createLogger("agent:routes:commands");

// Module-level singleton -- initialized on first use.
let _registry: CommandRegistry | null = null;

function getRegistry(): CommandRegistry {
  if (!_registry) {
    _registry = CommandRegistry.withDefaultDir();
  }
  return _registry;
}

/** Initialize the command registry (called from server startup). */
export function initCommandRoutes(): void {
  _registry = CommandRegistry.withDefaultDir();
  log.info("command routes initialized");
}

/** Reset the registry (for testing). */
export function resetCommandRoutes(): void {
  _registry = null;
}

// ---------------------------------------------------------------------------
// GET /commands — list all commands
// ---------------------------------------------------------------------------

export function handleListCommands(url: URL): Response {
  const registry = getRegistry();
  const namespace = url.searchParams.get("namespace") ?? undefined;
  const tier = url.searchParams.get("tier") ?? undefined;

  const commands = registry.list(namespace, tier);

  return new Response(
    JSON.stringify({ commands }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// GET /commands/:name — list commands by namespace
// ---------------------------------------------------------------------------

export function handleListCommandsByNamespace(namespace: string): Response {
  const registry = getRegistry();
  const commands = registry.list(namespace);

  return new Response(
    JSON.stringify({ namespace, commands }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// PUT /commands/:name — update command content
// ---------------------------------------------------------------------------

export async function handleUpdateCommand(
  name: string,
  request: Request,
): Promise<Response> {
  const registry = getRegistry();

  let body: { content: string };
  try {
    body = (await request.json()) as { content: string };
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!body.content || body.content.trim() === "") {
    return new Response(
      JSON.stringify({ error: "content must not be empty" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Resolve the command file path.
  const filePath = registry.getPath(name);
  if (!filePath) {
    return new Response(
      JSON.stringify({ error: `command not found: ${name}` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  // Atomic write: tmp file + rename.
  const tmpPath = filePath + ".tmp";
  try {
    await Bun.write(tmpPath, body.content);
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: `write error: ${err instanceof Error ? err.message : String(err)}`,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const { renameSync } = await import("node:fs");
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up tmp on rename failure.
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(tmpPath);
    } catch {
      // Best effort cleanup.
    }
    return new Response(
      JSON.stringify({
        error: `rename error: ${err instanceof Error ? err.message : String(err)}`,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Refresh the registry so the updated description is reflected.
  registry.refresh();

  log.info({ name, path: filePath }, "command updated");

  return new Response(
    JSON.stringify({ name, updated: true, path: filePath }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
