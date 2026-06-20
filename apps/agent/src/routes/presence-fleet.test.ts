/**
 * GET /presence/fleet route tests (fleet-aware-rules-eval, Phase 1.7).
 *
 * Covers the endpoint enrichment: alongside the machine list + resolved
 * `liveConsole`, the response now carries the resolved live-console machine's
 * `PresenceVector` (`liveConsoleVector`), or null when none resolves. The DB is
 * a thin fake returning fixture rows — `resolveLiveConsole(Vector)` are pure and
 * unit-tested in `services/fleet-presence.test.ts`; this asserts the wiring.
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
  getAgentId: () => "homelab",
}));

import { handleGetPresenceFleet } from "./presence-fleet";
import type { FleetPresence } from "@nexus/db";

function row(over: Partial<FleetPresence> & { machine: string }): FleetPresence {
  return {
    machine: over.machine,
    onConsole: over.onConsole ?? false,
    macActive: over.macActive ?? null,
    macLocked: over.macLocked ?? null,
    heartbeat: over.heartbeat ?? new Date(),
    vector: over.vector ?? null,
    updatedAt: over.updatedAt ?? new Date(),
  };
}

/** A fake Db whose `select().from()` resolves to the given rows. */
function fakeDb(rows: FleetPresence[]): never {
  return {
    select: () => ({ from: async () => rows }),
  } as never;
}

const STUDIO_VECTOR = {
  userId: "leo",
  macActive: {
    value: true,
    source: "mac" as const,
    updatedAt: new Date().toISOString(),
    confidence: "high" as const,
  },
  macLocked: { value: null, source: "mac" as const, updatedAt: new Date(0).toISOString(), confidence: "unknown" as const },
  macHost: {
    value: "studio",
    source: "mac" as const,
    updatedAt: new Date().toISOString(),
    confidence: "high" as const,
  },
  inMeeting: { value: null, source: "mac" as const, updatedAt: new Date(0).toISOString(), confidence: "unknown" as const },
  meetingEndsAt: { value: null, source: "mac" as const, updatedAt: new Date(0).toISOString(), confidence: "unknown" as const },
  isBedtime: { value: null, source: "mac" as const, updatedAt: new Date(0).toISOString(), confidence: "unknown" as const },
  phonePresent: { value: null, source: "mac" as const, updatedAt: new Date(0).toISOString(), confidence: "unknown" as const },
  phoneHome: { value: null, source: "mac" as const, updatedAt: new Date(0).toISOString(), confidence: "unknown" as const },
  macIdleSec: { value: null, source: "mac" as const, updatedAt: new Date(0).toISOString(), confidence: "unknown" as const },
  macFocus: { value: null, source: "mac" as const, updatedAt: new Date(0).toISOString(), confidence: "unknown" as const },
};

describe("GET /presence/fleet — enrichment (Phase 1.7)", () => {
  it("includes the resolved live-console machine's vector", async () => {
    const rows = [
      row({
        machine: "studio",
        onConsole: true,
        heartbeat: new Date(),
        vector: STUDIO_VECTOR as never,
      }),
    ];
    const res = await handleGetPresenceFleet(fakeDb(rows));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      liveConsole: string;
      liveConsoleVector: { macActive: { value: boolean }; macHost: { value: string } } | null;
      machines: unknown[];
    };
    expect(body.liveConsole).toBe("studio");
    expect(body.liveConsoleVector).not.toBeNull();
    expect(body.liveConsoleVector!.macActive.value).toBe(true);
    expect(body.liveConsoleVector!.macHost.value).toBe("studio");
    expect(body.machines).toHaveLength(1);
  });

  it("returns liveConsoleVector null when no machine is on-console", async () => {
    const rows = [row({ machine: "studio", onConsole: false, vector: STUDIO_VECTOR as never })];
    const res = await handleGetPresenceFleet(fakeDb(rows));
    const body = (await res.json()) as { liveConsoleVector: unknown };
    expect(body.liveConsoleVector).toBeNull();
  });

  it("returns liveConsoleVector null on an empty fleet (falls back to local)", async () => {
    const res = await handleGetPresenceFleet(fakeDb([]));
    const body = (await res.json()) as { liveConsole: string; liveConsoleVector: unknown };
    expect(body.liveConsole).toBe("homelab"); // local fallback
    expect(body.liveConsoleVector).toBeNull();
  });
});
