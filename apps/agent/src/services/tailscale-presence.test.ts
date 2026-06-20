/**
 * Tailscale presence poller tests (openspec/changes/mac-presence-observer,
 * Phase 1.5).
 *
 * Exercises the PURE classifier `classifyPhonePeer` against representative
 * `tailscale status --json` fixtures — no shelling out, no network, no timers.
 * The classification contract (spec § Tailscale Home Detection):
 *   - LAN-direct endpoint (RFC1918 CurAddr) → home + present
 *   - public address or DERP relay           → away + present
 *   - absent / offline peer                  → not present (home unknown)
 */

import { describe, expect, it, mock } from "bun:test";
import * as coreNode from "@nexus/core/node";

const loggerMock = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  fatal: mock(() => {}),
  child: () => loggerMock,
};

mock.module("@nexus/core/node", () => ({
  ...coreNode,
  logger: loggerMock,
  createLogger: () => loggerMock,
}));

import {
  classifyPhonePeer,
  type TailscaleStatus,
} from "./tailscale-presence";

// ── Fixture builder ─────────────────────────────────────────────────────────

function status(peers: Record<string, unknown>): TailscaleStatus {
  return {
    Self: { HostName: "homelab", OS: "linux" },
    Peer: peers,
  } as TailscaleStatus;
}

const PHONE_MATCH = "iphone";

describe("classifyPhonePeer — LAN-direct is home", () => {
  it("a phone with an RFC1918 CurAddr → home + present", () => {
    const s = status({
      "key-a": {
        HostName: "leo-iphone",
        OS: "iOS",
        Online: true,
        CurAddr: "192.168.1.4:41641",
        Relay: "dfw",
        TailscaleIPs: ["100.108.153.18"],
      },
    });
    const r = classifyPhonePeer(s, PHONE_MATCH);
    expect(r.phonePresent).toBe(true);
    expect(r.phoneHome).toBe(true);
  });

  it("treats a 10.x.x.x CurAddr as home too", () => {
    const s = status({
      p: {
        HostName: "leo-iphone",
        OS: "iOS",
        Online: true,
        CurAddr: "10.0.0.22:41641",
        Relay: "",
      },
    });
    expect(classifyPhonePeer(s, PHONE_MATCH).phoneHome).toBe(true);
  });
});

describe("classifyPhonePeer — public / DERP is away", () => {
  it("a relayed phone (empty CurAddr, Relay set) → present but away", () => {
    const s = status({
      p: {
        HostName: "leo-iphone",
        OS: "iOS",
        Online: true,
        CurAddr: "",
        Relay: "dfw",
        TailscaleIPs: ["100.94.121.119"],
      },
    });
    const r = classifyPhonePeer(s, PHONE_MATCH);
    expect(r.phonePresent).toBe(true);
    expect(r.phoneHome).toBe(false);
  });

  it("a public-IP CurAddr → present but away", () => {
    const s = status({
      p: {
        HostName: "leo-iphone",
        OS: "iOS",
        Online: true,
        CurAddr: "65.50.136.66:41641",
        Relay: "iad",
      },
    });
    const r = classifyPhonePeer(s, PHONE_MATCH);
    expect(r.phonePresent).toBe(true);
    expect(r.phoneHome).toBe(false);
  });
});

describe("classifyPhonePeer — absent / offline is not present", () => {
  it("an offline phone → not present, home unknown", () => {
    const s = status({
      p: {
        HostName: "leo-iphone",
        OS: "iOS",
        Online: false,
        CurAddr: "",
        Relay: "",
      },
    });
    const r = classifyPhonePeer(s, PHONE_MATCH);
    expect(r.phonePresent).toBe(false);
    expect(r.phoneHome).toBeNull();
  });

  it("no matching peer at all → not present, home unknown", () => {
    const s = status({
      desktop: { HostName: "desktop-vjiv", OS: "windows", Online: true, CurAddr: "", Relay: "iad" },
    });
    const r = classifyPhonePeer(s, PHONE_MATCH);
    expect(r.phonePresent).toBe(false);
    expect(r.phoneHome).toBeNull();
  });

  it("empty Peer map → not present", () => {
    const r = classifyPhonePeer(status({}), PHONE_MATCH);
    expect(r.phonePresent).toBe(false);
    expect(r.phoneHome).toBeNull();
  });
});

describe("classifyPhonePeer — peer identification", () => {
  it("matches by HostName substring (case-insensitive)", () => {
    const s = status({
      p: { HostName: "Leo-iPhone-15", OS: "iOS", Online: true, CurAddr: "192.168.1.4:1", Relay: "" },
    });
    expect(classifyPhonePeer(s, "iphone").phonePresent).toBe(true);
  });

  it("matches by DNSName when HostName is the generic 'localhost'", () => {
    const s = status({
      p: {
        HostName: "localhost",
        DNSName: "leo-iphone.tail296462.ts.net.",
        OS: "iOS",
        Online: true,
        CurAddr: "192.168.1.4:1",
        Relay: "",
      },
    });
    expect(classifyPhonePeer(s, "iphone").phoneHome).toBe(true);
  });

  it("matches by a TailscaleIP substring (stable per-device 100.x address)", () => {
    const s = status({
      p: {
        HostName: "localhost",
        OS: "iOS",
        Online: true,
        CurAddr: "192.168.1.4:1",
        Relay: "",
        TailscaleIPs: ["100.108.153.18", "fd7a:115c::1"],
      },
    });
    expect(classifyPhonePeer(s, "100.108.153.18").phoneHome).toBe(true);
  });

  it("picks the online peer when multiple peers match (offline ignored)", () => {
    const s = status({
      off: { HostName: "leo-iphone", OS: "iOS", Online: false, CurAddr: "", Relay: "" },
      on: { HostName: "leo-iphone", OS: "iOS", Online: true, CurAddr: "192.168.1.4:1", Relay: "" },
    });
    const r = classifyPhonePeer(s, "iphone");
    expect(r.phonePresent).toBe(true);
    expect(r.phoneHome).toBe(true);
  });
});
