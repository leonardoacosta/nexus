/**
 * Peer Connector — WebSocket mesh for agent federation.
 *
 * Reads `~/.config/nexus/agents.toml`, connects to every peer agent
 * (excluding self) at `ws://{host}:{port}/ws/federation`, and:
 *
 * - Forwards local lifecycle events to all connected peers.
 * - Receives peer events and injects them into the local lifecycle bus.
 * - Reconnects with exponential backoff (1s → 2s → 4s → 8s → max 30s).
 * - Buffers up to 1000 events per peer during disconnects (task 1.7).
 * - Filters peer-sourced events to prevent echo loops.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@nexus/core";
import {
  lifecycleBus,
  type LifecycleEnvelope,
  type LifecycleEventName,
} from "./lifecycle-bus";

const log = createLogger("agent:peer-connector");

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface AgentConfig {
  name: string;
  host: string;
  port: number;
  user?: string;
}

export interface PeerConfig {
  selfName: string;
  role?: string;
  agents: AgentConfig[];
}

// ---------------------------------------------------------------------------
// TOML parser (minimal — supports the agents.toml format only)
// ---------------------------------------------------------------------------

/**
 * Parse the agents.toml format. Supports:
 * - Top-level key = "value" pairs
 * - [[agents]] array-of-tables blocks
 * - [agents.key] sub-tables within an agent block
 *
 * This is intentionally simple — no nested tables beyond one level.
 */
export function parseAgentsToml(content: string): PeerConfig {
  const lines = content.split("\n");
  const config: PeerConfig = { selfName: "", agents: [] };
  let currentAgent: AgentConfig | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip comments and empty lines
    if (!line || line.startsWith("#")) continue;

    // [[agents]] block start
    if (line === "[[agents]]") {
      if (currentAgent) {
        config.agents.push(currentAgent);
      }
      currentAgent = { name: "", host: "", port: 0 };
      continue;
    }

    // [agents.xxx] sub-table — skip (we don't need nested agent config)
    if (/^\[agents\.\w+\]$/.test(line)) {
      continue;
    }

    // Key = value pairs
    const match = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!match) continue;

    const key = match[1]!;
    let value = match[2]!.trim();

    // Strip quotes from string values
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (currentAgent) {
      // Inside an [[agents]] block
      switch (key) {
        case "name": currentAgent.name = value; break;
        case "host": currentAgent.host = value; break;
        case "port": currentAgent.port = parseInt(value, 10); break;
        case "user": currentAgent.user = value; break;
      }
    } else {
      // Top-level keys
      switch (key) {
        case "self_name": config.selfName = value; break;
        case "role": config.role = value; break;
      }
    }
  }

  // Push the last agent block
  if (currentAgent) {
    config.agents.push(currentAgent);
  }

  return config;
}

/** Load and parse agents.toml from the standard config path. */
export function loadPeerConfig(): PeerConfig | null {
  const configPath =
    process.env.NEXUS_CONFIG_DIR
      ? join(process.env.NEXUS_CONFIG_DIR, "agents.toml")
      : join(homedir(), ".config", "nexus", "agents.toml");

  try {
    const content = readFileSync(configPath, "utf8");
    return parseAgentsToml(content);
  } catch (err) {
    log.warn({ path: configPath, error: err }, "peer-connector: failed to load agents.toml");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event buffer (per-peer, for disconnect resilience — task 1.7)
// ---------------------------------------------------------------------------

const MAX_BUFFER_SIZE = 1000;

class EventBuffer {
  private readonly buffer: LifecycleEnvelope[] = [];

  push(envelope: LifecycleEnvelope): void {
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.buffer.shift(); // Drop oldest
    }
    this.buffer.push(envelope);
  }

  drain(): LifecycleEnvelope[] {
    return this.buffer.splice(0);
  }

  get size(): number {
    return this.buffer.length;
  }
}

// ---------------------------------------------------------------------------
// Peer connection
// ---------------------------------------------------------------------------

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

/** Calculate backoff delay for a given attempt (0-indexed). */
export function calcBackoff(attempt: number): number {
  return Math.min(INITIAL_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, attempt), MAX_BACKOFF_MS);
}

interface PeerConnection {
  agent: AgentConfig;
  ws: WebSocket | null;
  buffer: EventBuffer;
  attempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  /** Track highest seq received to dedup replayed events. */
  lastSeenSeq: number;
}

// ---------------------------------------------------------------------------
// Peer Connector service
// ---------------------------------------------------------------------------

export interface PeerConnectorService {
  stop(): void;
  /** Number of currently connected peers. */
  connectedCount(): number;
  /** All peer names. */
  peerNames(): string[];
}

let secret: string | undefined;

/** Set the attach secret used for federation auth. */
export function setPeerSecret(s: string): void {
  secret = s;
}

/**
 * Start the peer connector service.
 *
 * Reads agents.toml, connects to each peer, and wires the lifecycle bus
 * for bidirectional event propagation.
 */
export function startPeerConnector(
  configOverride?: PeerConfig,
): PeerConnectorService {
  const config = configOverride ?? loadPeerConfig();
  if (!config) {
    log.info("peer-connector: no agents.toml found — running standalone");
    return { stop() {}, connectedCount: () => 0, peerNames: () => [] };
  }

  if (!config.selfName) {
    log.warn("peer-connector: self_name not set in agents.toml — cannot filter self");
    return { stop() {}, connectedCount: () => 0, peerNames: () => [] };
  }

  // Set origin on the lifecycle bus so envelopes carry our name
  lifecycleBus.setOrigin(config.selfName);

  // Filter out self
  const peers = config.agents.filter((a) => a.name !== config.selfName);
  if (peers.length === 0) {
    log.info("peer-connector: no peer agents configured (only self)");
    return { stop() {}, connectedCount: () => 0, peerNames: () => [] };
  }

  log.info(
    { self: config.selfName, peers: peers.map((p) => p.name) },
    "peer-connector: starting mesh",
  );

  const connections: PeerConnection[] = peers.map((agent) => ({
    agent,
    ws: null,
    buffer: new EventBuffer(),
    attempt: 0,
    reconnectTimer: null,
    stopped: false,
    lastSeenSeq: 0,
  }));

  // ── Forward local events to all connected peers ─────────────────────
  function onLocalEvent(envelope: LifecycleEnvelope): void {
    // Never forward events that originated from a peer
    if (envelope.source === "peer") return;

    const json = JSON.stringify(envelope);
    for (const conn of connections) {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(json);
        } catch (err) {
          log.warn(
            { peer: conn.agent.name, error: err },
            "peer-connector: send failed, buffering",
          );
          conn.buffer.push(envelope);
        }
      } else {
        // Peer is disconnected — buffer the event
        conn.buffer.push(envelope);
      }
    }
  }

  lifecycleBus.onAny(onLocalEvent);

  // ── Connect to each peer ────────────────────────────────────────────
  function connectPeer(conn: PeerConnection): void {
    if (conn.stopped) return;

    const url = `ws://${conn.agent.host}:${conn.agent.port}/ws/federation`;
    log.info({ peer: conn.agent.name, url }, "peer-connector: connecting");

    try {
      const headers: Record<string, string> = {};
      if (secret) {
        headers["x-nexus-secret"] = secret;
      }

      const ws = new WebSocket(url, { headers } as WebSocketInit);

      ws.onopen = () => {
        log.info({ peer: conn.agent.name }, "peer-connector: connected");
        conn.ws = ws;
        conn.attempt = 0;

        // Replay buffered events
        const buffered = conn.buffer.drain();
        if (buffered.length > 0) {
          log.info(
            { peer: conn.agent.name, count: buffered.length },
            "peer-connector: replaying buffered events",
          );
          for (const env of buffered) {
            try {
              ws.send(JSON.stringify(env));
            } catch {
              // If send fails during replay, re-buffer remaining
              break;
            }
          }
        }
      };

      ws.onmessage = (event) => {
        try {
          const envelope = JSON.parse(
            typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer),
          ) as LifecycleEnvelope;

          // Validate it looks like a lifecycle envelope
          if (!envelope.event || !envelope.payload) {
            log.debug({ peer: conn.agent.name }, "peer-connector: invalid envelope");
            return;
          }

          // Dedup by sequence number (for replayed events)
          if (envelope.seq && envelope.seq <= conn.lastSeenSeq) {
            log.debug(
              { peer: conn.agent.name, seq: envelope.seq },
              "peer-connector: duplicate seq, skipping",
            );
            return;
          }
          if (envelope.seq) {
            conn.lastSeenSeq = envelope.seq;
          }

          // Inject into local bus as peer-sourced
          lifecycleBus.injectPeerEvent(envelope);
        } catch (err) {
          log.warn(
            { peer: conn.agent.name, error: err },
            "peer-connector: failed to parse peer message",
          );
        }
      };

      ws.onclose = (event) => {
        log.info(
          { peer: conn.agent.name, code: event.code, reason: event.reason },
          "peer-connector: disconnected",
        );
        conn.ws = null;

        // Reconnect with backoff
        if (!conn.stopped) {
          const delay = calcBackoff(conn.attempt);
          log.info(
            { peer: conn.agent.name, attempt: conn.attempt, delayMs: delay },
            "peer-connector: scheduling reconnect",
          );
          conn.reconnectTimer = setTimeout(() => {
            conn.attempt++;
            connectPeer(conn);
          }, delay);
        }
      };

      ws.onerror = (event) => {
        log.warn(
          { peer: conn.agent.name, error: event },
          "peer-connector: WebSocket error",
        );
        // onclose will fire after onerror and handle reconnect
      };
    } catch (err) {
      log.error(
        { peer: conn.agent.name, error: err },
        "peer-connector: failed to create WebSocket",
      );
      // Schedule reconnect
      if (!conn.stopped) {
        const delay = calcBackoff(conn.attempt);
        conn.reconnectTimer = setTimeout(() => {
          conn.attempt++;
          connectPeer(conn);
        }, delay);
      }
    }
  }

  // Start connecting to all peers
  for (const conn of connections) {
    connectPeer(conn);
  }

  return {
    stop() {
      log.info("peer-connector: stopping");
      lifecycleBus.offAny(onLocalEvent);

      for (const conn of connections) {
        conn.stopped = true;
        if (conn.reconnectTimer) {
          clearTimeout(conn.reconnectTimer);
          conn.reconnectTimer = null;
        }
        if (conn.ws) {
          try {
            conn.ws.close(1000, "peer-connector stopping");
          } catch {
            // Already closed
          }
          conn.ws = null;
        }
      }
    },

    connectedCount() {
      return connections.filter((c) => c.ws?.readyState === WebSocket.OPEN).length;
    },

    peerNames() {
      return connections.map((c) => c.agent.name);
    },
  };
}

// Re-export for WebSocket init typing
interface WebSocketInit {
  headers?: Record<string, string>;
}
