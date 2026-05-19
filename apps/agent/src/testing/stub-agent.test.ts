/**
 * Tests for the stub-agent harness (add-fullstack-integration-test-gate 1.4).
 *
 * The load-bearing scenario: the harness MUST throw fast when handed a
 * loopback-ish address (macOS ATS exempts loopback / *.local from its
 * cleartext policy, which would false-green the -1022 transport fault), and
 * MUST actually serve the deterministic fixtures when bound to a real
 * non-loopback interface.
 */

import { describe, expect, it, afterEach } from "bun:test";
import {
  startStubAgent,
  isLoopbackish,
  discoverNonLoopbackIPv4,
  SESSIONS_FIXTURE,
  HEALTH_FIXTURE,
  EVENTS_FIXTURE,
  type StubAgentHandle,
} from "./stub-agent";

let handle: StubAgentHandle | null = null;

afterEach(() => {
  handle?.stop();
  handle = null;
});

describe("stub-agent loopback guard (enforced spec scenario)", () => {
  it.each(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "foo.local", "127.5.5.5"])(
    "throws fast when handed loopback-ish host %p",
    (host) => {
      expect(isLoopbackish(host)).toBe(true);
      expect(() => startStubAgent({ host })).toThrow(/refusing to bind loopback/i);
    },
  );

  it("does NOT classify a real LAN/Tailscale IPv4 as loopback", () => {
    expect(isLoopbackish("10.61.142.78")).toBe(false);
    expect(isLoopbackish("192.168.1.20")).toBe(false);
    expect(isLoopbackish("100.91.88.16")).toBe(false);
  });
});

describe("stub-agent serves deterministic fixtures on a non-loopback bind", () => {
  it("binds a non-loopback IPv4 and serves /sessions, /health, /events", async () => {
    const ip = discoverNonLoopbackIPv4();
    expect(isLoopbackish(ip)).toBe(false);

    handle = startStubAgent({ host: ip });
    expect(isLoopbackish(handle.host)).toBe(false);
    expect(handle.baseUrl).toBe(`http://${ip}:${handle.port}`);

    const sessions = await (
      await fetch(`${handle.baseUrl}/sessions`)
    ).json();
    expect(sessions).toEqual(JSON.parse(JSON.stringify(SESSIONS_FIXTURE)));

    const health = await (await fetch(`${handle.baseUrl}/health`)).json();
    expect(health).toEqual(JSON.parse(JSON.stringify(HEALTH_FIXTURE)));

    const events = await (await fetch(`${handle.baseUrl}/events`)).json();
    expect(events).toEqual(JSON.parse(JSON.stringify(EVENTS_FIXTURE)));
  });
});
