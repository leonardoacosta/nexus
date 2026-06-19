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
} from "./presence-context";
import { MeetingState } from "./meeting-state";
import { lifecycleBus } from "../services/lifecycle-bus";
import type { PresenceChangedPayload } from "../services/lifecycle-bus";

const USER = "leo";

describe("PresenceContext — field merge", () => {
  it("merges reported fields into the vector", () => {
    const ctx = new PresenceContext(USER);
    ctx.report({ macActive: true, macHost: "studio" }, "mac");

    const v = ctx.vector();
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

  it("emits PresenceChanged with the updated vector and changed keys", () => {
    const ctx = new PresenceContext(USER);
    ctx.report({ macActive: true, macHost: "studio" }, "mac");

    expect(received).toHaveLength(1);
    expect(received[0]!.changed.sort()).toEqual(["macActive", "macHost"]);
    expect(received[0]!.vector.macActive.value).toBe(true);
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
