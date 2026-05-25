/**
 * mac-tts-integration-test (task 1.1 / 1.2) — TS-side harness coverage.
 *
 * The integration round-trip is `agent NotificationFired SSE -> Swift
 * TTSObserver -> audio/synthesis path`. This file locks the AGENT half: the
 * stub-agent emits a well-formed `NotificationFired` SSE frame in the exact
 * wire shape the Swift `SSEEvent.decodeNotification()` consumes
 * (`event: NotificationFired\ndata: {...}\n\n`, with a non-empty `body`).
 *
 * The Swift half (TTSObserver consumes the frame and invokes the mocked
 * synth/audio path) lives in
 * `apps/swift/nexus-mac/Tests/TTSNotificationFiredRoundTripTests.swift` and
 * runs under the host-bundled nexus-mac-Tests target — it XCTSkips cleanly
 * when no audio/Xcode test env is available.
 *
 * Why a loopback stub here is correct: this is NOT the client-transport ATS
 * (`-1022`) gate (which deliberately binds a non-loopback IPv4). The SSE
 * round-trip only needs a frame on the wire, so `allowLoopback: true` keeps
 * it deterministic and CI-portable.
 */

import { describe, expect, it } from "bun:test";
import {
  startStubAgent,
  encodeNotificationFiredFrame,
  type StubNotificationFired,
} from "./stub-agent";

describe("stub-agent NotificationFired SSE frame (mac-tts harness)", () => {
  // ── 1) Pure frame encoder — the exact shape decodeNotification() reads ─────

  it("encodes a canonical `event: NotificationFired` frame with non-empty body", () => {
    const fixture: StubNotificationFired = {
      body: "wave 1 build complete",
      channel: "tts",
      title: "Nexus",
      project: "nx",
    };
    const frame = encodeNotificationFiredFrame(fixture);

    // SSE framing: named event + data line + blank-line terminator.
    expect(frame.startsWith("event: NotificationFired\n")).toBe(true);
    expect(frame.includes("\ndata: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);

    // The data line is valid JSON carrying the fields the Swift decoder reads.
    const dataLine = frame
      .split("\n")
      .find((l) => l.startsWith("data: "))!
      .slice("data: ".length);
    const payload = JSON.parse(dataLine) as Record<string, unknown>;
    expect(payload.body).toBe("wave 1 build complete");
    expect(payload.channel).toBe("tts");
    expect(payload.title).toBe("Nexus");
    expect(payload.project).toBe("nx");
    // body is non-empty — decodeNotification() drops empty-body frames.
    expect(String(payload.body).length).toBeGreaterThan(0);
  });

  it("omits absent optional fields rather than emitting nulls", () => {
    const frame = encodeNotificationFiredFrame({ body: "minimal" });
    const dataLine = frame
      .split("\n")
      .find((l) => l.startsWith("data: "))!
      .slice("data: ".length);
    const payload = JSON.parse(dataLine) as Record<string, unknown>;
    expect(payload.body).toBe("minimal");
    // No channel/title/project keys when not supplied (clean wire shape).
    expect("channel" in payload).toBe(false);
    expect("title" in payload).toBe(false);
    expect("project" in payload).toBe(false);
  });

  // ── 2) End-to-end over HTTP — a real SSE consumer reads the frame back ─────

  it("serves the NotificationFired frame over GET /events/stream", async () => {
    const stub = startStubAgent({
      host: "127.0.0.1",
      allowLoopback: true,
      notificationFired: {
        body: "round-trip notification",
        channel: "tts",
        title: "Nexus",
        project: "nx",
      },
    });

    try {
      const res = await fetch(`${stub.baseUrl}/events/stream`, {
        headers: { Accept: "text/event-stream" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      // Read the first SSE frame (the stub holds the stream open after it, so
      // we read just enough bytes to see the terminating blank line).
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // Pull chunks until we have a full frame (ends with a blank line).
      while (!buf.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      await reader.cancel();

      // The consumer sees the named event + JSON data the Swift decoder parses.
      expect(buf).toContain("event: NotificationFired");
      const dataLine = buf
        .split("\n")
        .find((l) => l.startsWith("data: "))!
        .slice("data: ".length);
      const payload = JSON.parse(dataLine) as Record<string, unknown>;
      expect(payload.body).toBe("round-trip notification");
      expect(payload.channel).toBe("tts");
    } finally {
      stub.stop();
    }
  });

  // ── 3) The route only exists when a fixture is supplied ───────────────────

  it("404s on /events/stream when no NotificationFired fixture is configured", async () => {
    const stub = startStubAgent({ host: "127.0.0.1", allowLoopback: true });
    try {
      const res = await fetch(`${stub.baseUrl}/events/stream`);
      expect(res.status).toBe(404);
    } finally {
      stub.stop();
    }
  });

  // ── 4) Loopback guard is still enforced by default (ATS gate unbroken) ─────

  it("still refuses a loopback bind without allowLoopback (ATS -1022 guard intact)", () => {
    expect(() => startStubAgent({ host: "127.0.0.1" })).toThrow(/loopback/i);
  });
});
