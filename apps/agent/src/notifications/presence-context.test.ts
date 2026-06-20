/**
 * Presence-context singleton tests (openspec/changes/context-aware-routing).
 *
 * Covers: field merge, TTL -> unknown, PresenceChanged emission, and the
 * meeting-state -> inMeeting feed. No live DB — the context is in-memory.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
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
  PresenceContext,
  MAC_FIELD_TTL_MS,
  PHONE_FIELD_TTL_MS,
} from "./presence-context";
import { MeetingState } from "./meeting-state";
import { lifecycleBus } from "../services/lifecycle-bus";
import type { PresenceChangedPayload } from "../services/lifecycle-bus";

const USER = "leo";

describe("PresenceContext — field merge", () => {
  it("merges reported fields into the reporting machine's vector", () => {
    const ctx = new PresenceContext(USER);
    // A report carrying macHost keys into that machine's per-machine bucket.
    ctx.report({ macActive: true, macHost: "studio" }, "mac");

    const v = ctx.vectorFor("studio");
    expect(v.macActive.value).toBe(true);
    expect(v.macActive.confidence).not.toBe("unknown");
    expect(v.macHost.value).toBe("studio");
    expect(v.macHost.source).toBe("mac");
  });

  it("leaves un-reported fields unknown", () => {
    const ctx = new PresenceContext(USER);
    ctx.report({ macActive: true }, "mac");
    const v = ctx.vector();
    expect(v.macLocked.confidence).toBe("unknown");
    expect(v.macLocked.value).toBeNull();
  });

  it("a later report overrides an earlier value", () => {
    const ctx = new PresenceContext(USER);
    ctx.report({ macActive: true }, "mac");
    ctx.report({ macActive: false }, "mac");
    expect(ctx.vector().macActive.value).toBe(false);
  });
});

describe("PresenceContext — TTL collapses to unknown", () => {
  it("reads a mac field as unknown once its updatedAt is past the TTL", () => {
    const ctx = new PresenceContext(USER);
    const stale = new Date(Date.now() - MAC_FIELD_TTL_MS - 1_000).toISOString();
    ctx.report({ macActive: true }, "mac", stale);

    const v = ctx.vector();
    expect(v.macActive.confidence).toBe("unknown");
    expect(v.macActive.value).toBeNull();
  });

  it("reads a fresh mac field as a known value", () => {
    const ctx = new PresenceContext(USER);
    ctx.report({ macActive: true }, "mac"); // now
    expect(ctx.vector().macActive.confidence).not.toBe("unknown");
    expect(ctx.vector().macActive.value).toBe(true);
  });
});

describe("PresenceContext — phone fields (Phase 1.5)", () => {
  it("merges phonePresent / phoneHome with the derived source", () => {
    const ctx = new PresenceContext(USER);
    ctx.report({ phonePresent: true, phoneHome: true }, "derived");

    const v = ctx.vector();
    expect(v.phonePresent.value).toBe(true);
    expect(v.phonePresent.source).toBe("derived");
    expect(v.phoneHome.value).toBe(true);
    expect(v.phoneHome.confidence).not.toBe("unknown");
  });

  it("a phone field past its 2-min TTL reads unknown", () => {
    const ctx = new PresenceContext(USER);
    const stale = new Date(Date.now() - PHONE_FIELD_TTL_MS - 1_000).toISOString();
    ctx.report({ phonePresent: true, phoneHome: true }, "derived", stale);

    const v = ctx.vector();
    expect(v.phonePresent.confidence).toBe("unknown");
    expect(v.phonePresent.value).toBeNull();
    expect(v.phoneHome.confidence).toBe("unknown");
    expect(v.phoneHome.value).toBeNull();
  });

  it("a fresh phone field reads a known value", () => {
    const ctx = new PresenceContext(USER);
    ctx.report({ phonePresent: true, phoneHome: false }, "derived");
    expect(ctx.vector().phonePresent.value).toBe(true);
    expect(ctx.vector().phoneHome.value).toBe(false);
    expect(ctx.vector().phoneHome.confidence).not.toBe("unknown");
  });

  it("leaves phone fields unknown when never reported", () => {
    const ctx = new PresenceContext(USER);
    ctx.report({ macActive: true }, "mac");
    const v = ctx.vector();
    expect(v.phonePresent.confidence).toBe("unknown");
    expect(v.phoneHome.confidence).toBe("unknown");
  });
});

describe("PresenceContext — mac sensor fields (Phase 1.5)", () => {
  it("merges macIdleSec / macFocus from the headless sensor", () => {
    const ctx = new PresenceContext(USER);
    ctx.report({ macIdleSec: 42, macFocus: "work" }, "mac");

    const v = ctx.vector();
    expect(v.macIdleSec.value).toBe(42);
    expect(v.macIdleSec.confidence).not.toBe("unknown");
    expect(v.macFocus.value).toBe("work");
    expect(v.macFocus.source).toBe("mac");
  });

  it("a mac sensor field past the mac TTL reads unknown", () => {
    const ctx = new PresenceContext(USER);
    const stale = new Date(Date.now() - MAC_FIELD_TTL_MS - 1_000).toISOString();
    ctx.report({ macIdleSec: 99 }, "mac", stale);
    expect(ctx.vector().macIdleSec.confidence).toBe("unknown");
    expect(ctx.vector().macIdleSec.value).toBeNull();
  });
});

describe("PresenceContext — PresenceChanged emission", () => {
  let received: PresenceChangedPayload[] = [];
  const handler = (e: { payload: PresenceChangedPayload }) => {
    received.push(e.payload);
  };

  beforeEach(() => {
    received = [];
    lifecycleBus.removeAllListeners();
    lifecycleBus.on("PresenceChanged", handler);
  });

  it("emits PresenceChanged with the changed keys", () => {
    const ctx = new PresenceContext(USER);
    ctx.report({ macActive: true, macHost: "studio" }, "mac");

    expect(received).toHaveLength(1);
    expect(received[0]!.changed.sort()).toEqual(["macActive", "macHost"]);
  });

  it("the emitted payload carries the local machine's vector", () => {
    const ctx = new PresenceContext(USER, "homelab");
    // A local report (no macHost) is reflected in the emitted local vector.
    ctx.report({ macActive: true }, "mac");

    expect(received).toHaveLength(1);
    expect(received[0]!.vector.macActive.value).toBe(true);
  });
});

describe("PresenceContext — per-machine vector map (Phase 1.7)", () => {
  it("keys a report by its macHost, not the local machine", () => {
    const ctx = new PresenceContext(USER, "homelab");
    ctx.report({ macActive: true, macHost: "studio" }, "mac");

    // The remote machine's bucket carries the report…
    const studio = ctx.vectorFor("studio");
    expect(studio.macActive.value).toBe(true);
    expect(studio.macHost.value).toBe("studio");

    // …and the LOCAL bucket is untouched (still unknown).
    const local = ctx.vector();
    expect(local.macActive.confidence).toBe("unknown");
  });

  it("falls back to the local machine when macHost is absent", () => {
    const ctx = new PresenceContext(USER, "homelab");
    ctx.report({ macActive: true }, "mac");

    const local = ctx.vector();
    expect(local.macActive.value).toBe(true);
    expect(ctx.machines()).toContain("homelab");
  });

  it("two machines reporting do not clobber each other", () => {
    const ctx = new PresenceContext(USER, "homelab");
    ctx.report({ macActive: true, macHost: "studio" }, "mac");
    ctx.report({ macActive: false, macHost: "laptop" }, "mac");

    expect(ctx.vectorFor("studio").macActive.value).toBe(true);
    expect(ctx.vectorFor("laptop").macActive.value).toBe(false);
  });

  it("applies per-field TTL independently per machine", () => {
    const ctx = new PresenceContext(USER, "homelab");
    const stale = new Date(Date.now() - MAC_FIELD_TTL_MS - 1_000).toISOString();
    ctx.report({ macActive: true, macHost: "studio" }, "mac", stale);
    ctx.report({ macActive: true, macHost: "laptop" }, "mac"); // fresh

    expect(ctx.vectorFor("studio").macActive.confidence).toBe("unknown");
    expect(ctx.vectorFor("laptop").macActive.value).toBe(true);
  });

  it("an unknown machine reads an all-unknown vector", () => {
    const ctx = new PresenceContext(USER, "homelab");
    const v = ctx.vectorFor("never-reported");
    expect(v.macActive.confidence).toBe("unknown");
    expect(v.userId).toBe(USER);
  });
});

describe("PresenceContext — per-machine fleet upsert (nx-vbv39 regression)", () => {
  it("a remote report writes that remote machine's fleet_presence row", async () => {
    const upserts: Array<{ machine: string; onConsole: boolean }> = [];
    const fakeDb = {} as never;
    const ctx = new PresenceContext(USER, "homelab");
    ctx.bindFleetPresence(fakeDb, "homelab", 1_000_000, async (_db, machine, state) => {
      upserts.push({ machine, onConsole: state.onConsole });
    });
    // The boot upsert writes the local self-row.
    expect(upserts.some((u) => u.machine === "homelab")).toBe(true);
    upserts.length = 0;

    // A remote Mac reports — the headless agent must persist STUDIO's row,
    // not (only) its own self-row. This is the nx-vbv39 fix.
    ctx.report({ macActive: true, macLocked: false, macHost: "studio" }, "mac");
    await Promise.resolve();
    await Promise.resolve();

    const studio = upserts.find((u) => u.machine === "studio");
    expect(studio).toBeDefined();
    expect(studio!.onConsole).toBe(true); // macActive && !macLocked

    ctx.unbindFleetPresence();
  });

  it("writes the FULL vector jsonb in the upsert", async () => {
    const upserts: Array<{ machine: string; vector: unknown }> = [];
    const ctx = new PresenceContext(USER, "homelab");
    ctx.bindFleetPresence({} as never, "homelab", 1_000_000, async (_db, machine, state) => {
      upserts.push({ machine, vector: state.vector });
    });
    upserts.length = 0;

    ctx.report({ macActive: true, macHost: "studio" }, "mac");
    await Promise.resolve();
    await Promise.resolve();

    const studio = upserts.find((u) => u.machine === "studio");
    expect(studio).toBeDefined();
    const v = studio!.vector as { macActive: { value: boolean }; userId: string };
    expect(v.macActive.value).toBe(true);
    expect(v.userId).toBe(USER);

    ctx.unbindFleetPresence();
  });

  it("the local self-row is still written on a local report", async () => {
    const upserts: string[] = [];
    const ctx = new PresenceContext(USER, "homelab");
    ctx.bindFleetPresence({} as never, "homelab", 1_000_000, async (_db, machine) => {
      upserts.push(machine);
    });
    upserts.length = 0;

    ctx.report({ macActive: true }, "mac"); // no macHost → local
    await Promise.resolve();
    await Promise.resolve();

    expect(upserts).toContain("homelab");
    ctx.unbindFleetPresence();
  });
});

describe("PresenceContext — meeting-state feeds inMeeting", () => {
  it("sets inMeeting true with source agent-cli when meeting-state goes active", () => {
    const ctx = new PresenceContext(USER);
    const meeting = new MeetingState();
    ctx.bindMeetingState(meeting);

    meeting.start();
    ctx.syncMeetingState();

    const v = ctx.vector();
    expect(v.inMeeting.value).toBe(true);
    expect(v.inMeeting.source).toBe("agent-cli");
  });

  it("sets inMeeting false when the meeting ends", () => {
    const ctx = new PresenceContext(USER);
    const meeting = new MeetingState();
    ctx.bindMeetingState(meeting);

    meeting.start();
    ctx.syncMeetingState();
    meeting.end();
    ctx.syncMeetingState();

    expect(ctx.vector().inMeeting.value).toBe(false);
  });
});
