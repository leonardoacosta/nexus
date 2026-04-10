import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  parseAgentsToml,
  calcBackoff,
  type PeerConfig,
} from "./peer-connector";
import { LifecycleBus, type LifecycleEnvelope } from "./lifecycle-bus";

// ---------------------------------------------------------------------------
// TOML parsing
// ---------------------------------------------------------------------------

describe("parseAgentsToml", () => {
  test("parses self_name and agents", () => {
    const toml = `
# Nexus Agent Registry
self_name = "omarchy"
role = "agent"

[[agents]]
name = "omarchy"
host = "localhost"
port = 7400
user = "nyaptor"

[[agents]]
name = "macbook"
host = "macbook-pro"
port = 7400
user = "leonardoacosta"
`;
    const config = parseAgentsToml(toml);
    expect(config.selfName).toBe("omarchy");
    expect(config.role).toBe("agent");
    expect(config.agents).toHaveLength(2);
    expect(config.agents[0]!.name).toBe("omarchy");
    expect(config.agents[0]!.host).toBe("localhost");
    expect(config.agents[0]!.port).toBe(7400);
    expect(config.agents[0]!.user).toBe("nyaptor");
    expect(config.agents[1]!.name).toBe("macbook");
    expect(config.agents[1]!.host).toBe("macbook-pro");
    expect(config.agents[1]!.port).toBe(7400);
  });

  test("handles quoted and unquoted values", () => {
    const toml = `
self_name = omarchy
[[agents]]
name = "test"
host = 'some-host'
port = 8080
`;
    const config = parseAgentsToml(toml);
    expect(config.selfName).toBe("omarchy");
    expect(config.agents[0]!.name).toBe("test");
    expect(config.agents[0]!.host).toBe("some-host");
    expect(config.agents[0]!.port).toBe(8080);
  });

  test("ignores comments and empty lines", () => {
    const toml = `
# Comment
self_name = "test"

# Another comment

[[agents]]
name = "a1"
host = "h1"
port = 7400
`;
    const config = parseAgentsToml(toml);
    expect(config.selfName).toBe("test");
    expect(config.agents).toHaveLength(1);
  });

  test("handles empty input", () => {
    const config = parseAgentsToml("");
    expect(config.selfName).toBe("");
    expect(config.agents).toHaveLength(0);
  });

  test("handles agents with sub-tables", () => {
    const toml = `
self_name = "a1"

[[agents]]
name = "a1"
host = "localhost"
port = 7400

[agents.extra]
some_key = "value"

[[agents]]
name = "a2"
host = "remote"
port = 7400
`;
    const config = parseAgentsToml(toml);
    expect(config.agents).toHaveLength(2);
    expect(config.agents[0]!.name).toBe("a1");
    expect(config.agents[1]!.name).toBe("a2");
  });

  test("multiple agents parse correctly", () => {
    const toml = `
self_name = "hub"

[[agents]]
name = "node1"
host = "10.0.0.1"
port = 7400

[[agents]]
name = "node2"
host = "10.0.0.2"
port = 7401

[[agents]]
name = "node3"
host = "10.0.0.3"
port = 7402
`;
    const config = parseAgentsToml(toml);
    expect(config.agents).toHaveLength(3);
    expect(config.agents.map((a) => a.name)).toEqual(["node1", "node2", "node3"]);
    expect(config.agents.map((a) => a.port)).toEqual([7400, 7401, 7402]);
  });
});

// ---------------------------------------------------------------------------
// Self-filtering
// ---------------------------------------------------------------------------

describe("self-filtering", () => {
  test("peers list excludes self_name", () => {
    const config = parseAgentsToml(`
self_name = "omarchy"
[[agents]]
name = "omarchy"
host = "localhost"
port = 7400
[[agents]]
name = "macbook"
host = "macbook-pro"
port = 7400
`);

    const peers = config.agents.filter((a) => a.name !== config.selfName);
    expect(peers).toHaveLength(1);
    expect(peers[0]!.name).toBe("macbook");
  });

  test("all agents are self returns empty peers", () => {
    const config = parseAgentsToml(`
self_name = "solo"
[[agents]]
name = "solo"
host = "localhost"
port = 7400
`);

    const peers = config.agents.filter((a) => a.name !== config.selfName);
    expect(peers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Backoff calculation
// ---------------------------------------------------------------------------

describe("calcBackoff", () => {
  test("attempt 0 returns 1s", () => {
    expect(calcBackoff(0)).toBe(1000);
  });

  test("attempt 1 returns 2s", () => {
    expect(calcBackoff(1)).toBe(2000);
  });

  test("attempt 2 returns 4s", () => {
    expect(calcBackoff(2)).toBe(4000);
  });

  test("attempt 3 returns 8s", () => {
    expect(calcBackoff(3)).toBe(8000);
  });

  test("attempt 4 returns 16s", () => {
    expect(calcBackoff(4)).toBe(16000);
  });

  test("caps at 30s", () => {
    expect(calcBackoff(5)).toBe(30000); // 32s capped to 30s
    expect(calcBackoff(10)).toBe(30000);
    expect(calcBackoff(100)).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// Event forwarding (local → peer, peer → local, no echo)
// ---------------------------------------------------------------------------

describe("event forwarding logic", () => {
  let bus: LifecycleBus;

  beforeEach(() => {
    bus = new LifecycleBus();
    bus.setOrigin("test-agent");
  });

  afterEach(() => {
    bus.removeAllListeners();
  });

  test("local events have source=local", () => {
    const received: LifecycleEnvelope[] = [];
    bus.onAny((env) => received.push(env));

    bus.emit("SessionStarted", { sessionId: "s1" });

    expect(received[0]!.source).toBe("local");
    expect(received[0]!.origin).toBe("test-agent");
  });

  test("peer-injected events have source=peer", () => {
    const received: LifecycleEnvelope[] = [];
    bus.onAny((env) => received.push(env));

    bus.injectPeerEvent({
      event: "SessionStarted",
      payload: { sessionId: "remote-1" },
      source: "local", // Should be overwritten
      seq: 1,
      ts: new Date().toISOString(),
      origin: "remote-agent",
    });

    expect(received[0]!.source).toBe("peer");
  });

  test("echo suppression: wildcard handler can filter peer events", () => {
    // Simulates peer-connector behavior: only forward local events
    const forwarded: LifecycleEnvelope[] = [];

    bus.onAny((env) => {
      if (env.source !== "peer") {
        forwarded.push(env);
      }
    });

    // Local event — should be forwarded
    bus.emit("SessionStarted", { sessionId: "local-1" });

    // Peer event — should NOT be forwarded
    bus.injectPeerEvent({
      event: "SessionStopped",
      payload: { sessionId: "remote-1" },
      source: "peer",
      seq: 10,
      ts: new Date().toISOString(),
      origin: "other-agent",
    });

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.payload).toEqual({ sessionId: "local-1" });
  });
});
