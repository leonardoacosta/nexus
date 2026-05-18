#!/usr/bin/env bun
/**
 * nexus-emit — minimal Unix-domain-socket client that emits one event line
 * to the local nexus-agent.
 *
 * Spec: openspec/changes/add-socket-hook-helper
 *
 * Why this exists:
 *   The deploy / git hooks that fire `nexus-emit` run in tight, single-shot
 *   contexts (post-merge, pre-push) where pulling in `bun run apps/agent/...`
 *   or even the full agent binary is overkill. A standalone helper compiled
 *   to a ~5MB binary keeps the per-hook latency around 10ms.
 *
 * Protocol:
 *   - Connect to NEXUS_SOCKET (default `/tmp/nexus-agent.sock`).
 *   - Write one JSON payload followed by `\n`.
 *   - Close immediately. The agent's socket-server parses events as
 *     newline-delimited JSON — see `apps/agent/src/services/socket-server/server.ts`.
 *
 * Usage:
 *   nexus-emit '{"event":"deploy_status","status":"deployed","service":"agent"}'
 *   nexus-emit --event deploy_status --status deployed --service agent
 *   echo '<json>' | nexus-emit -
 *
 * Exit codes:
 *   0  payload delivered
 *   2  bad arguments / invalid JSON
 *   3  socket connection failed (agent not running, perms wrong, stale path)
 */

const DEFAULT_SOCKET = "/tmp/nexus-agent.sock";

interface CliInput {
  json: string;
  socket: string;
}

function fail(code: number, message: string): never {
  process.stderr.write(`nexus-emit: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliInput {
  const socket = process.env.NEXUS_SOCKET ?? DEFAULT_SOCKET;
  const args = argv.slice(2);
  if (args.length === 0) fail(2, "usage: nexus-emit <json> | --key value ... | -");

  // Stdin pipe form
  if (args.length === 1 && args[0] === "-") {
    return { json: readStdin(), socket };
  }

  // Positional JSON form
  if (args.length === 1 && args[0]!.startsWith("{")) {
    return { json: args[0]!, socket };
  }

  // --key value ... form
  const obj: Record<string, string | number> = {};
  for (let i = 0; i < args.length; i += 2) {
    const raw = args[i];
    if (!raw || !raw.startsWith("--")) fail(2, `expected --key, got: ${raw}`);
    const key = raw.slice(2);
    const value = args[i + 1];
    if (value === undefined) fail(2, `missing value for --${key}`);
    // Best-effort numeric coercion to keep the agent's discriminator strict.
    obj[key] = /^-?\d+$/.test(value) ? Number(value) : value;
  }
  return { json: JSON.stringify(obj), socket };
}

function readStdin(): string {
  // Bun.stdin is async-iterable; read synchronously into a buffer.
  const chunks: Uint8Array[] = [];
  const stream = process.stdin;
  // Node-shaped sync read fallback for the simple case.
  let data = "";
  try {
    data = require("node:fs").readFileSync(0, "utf8");
  } catch (err) {
    fail(2, `stdin read failed: ${(err as Error).message}`);
  }
  void chunks;
  void stream;
  return data;
}

async function emit(input: CliInput): Promise<void> {
  // Validate JSON before opening the socket — avoids dirtying the agent
  // log with parse-failure noise.
  try {
    JSON.parse(input.json);
  } catch (err) {
    fail(2, `payload is not valid JSON: ${(err as Error).message}`);
  }

  try {
    const socket = await Bun.connect({
      unix: input.socket,
      socket: {
        open(sock) {
          sock.write(input.json.trim() + "\n");
          sock.end();
        },
        data() {},
        close() {},
        error(_sock, err) {
          fail(3, `socket error: ${err.message}`);
        },
      },
    });
    // Ensure the write flushes before exit.
    socket.end();
  } catch (err) {
    fail(3, `connect failed (${input.socket}): ${(err as Error).message}`);
  }
}

await emit(parseArgs(process.argv));
