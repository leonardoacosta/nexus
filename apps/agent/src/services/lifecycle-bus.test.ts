import { describe, test, expect, beforeEach } from "bun:test";
import {
  LifecycleBus,
  type LifecycleEnvelope,
  type SessionStartedPayload,
  type SessionStoppedPayload,
  type SpecTransitionPayload,
} from "./lifecycle-bus";

describe("LifecycleBus", () => {
  let bus: LifecycleBus;

  beforeEach(() => {
    bus = new LifecycleBus();
  });

  // ── Basic emit / on ─────────────────────────────────────────────────

  test("emit fires typed event to subscriber", () => {
    const received: LifecycleEnvelope<"SessionStarted">[] = [];
    bus.on("SessionStarted", (env) => received.push(env));

    bus.emit("SessionStarted", {
      sessionId: "s1",
      project: "nx",
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.event).toBe("SessionStarted");
    expect(received[0]!.payload.sessionId).toBe("s1");
    expect(received[0]!.payload.project).toBe("nx");
    expect(received[0]!.seq).toBe(1);
    expect(received[0]!.ts).toBeTruthy();
  });

  test("emit increments sequence numbers", () => {
    const seqs: number[] = [];
    bus.on("SessionStarted", (env) => seqs.push(env.seq));
    bus.on("SessionStopped", (env) => seqs.push(env.seq));

    bus.emit("SessionStarted", { sessionId: "s1" });
    bus.emit("SessionStopped", { sessionId: "s2" });
    bus.emit("SessionStarted", { sessionId: "s3" });

    expect(seqs).toEqual([1, 2, 3]);
    expect(bus.currentSeq).toBe(3);
  });

  // ── Multiple subscribers ────────────────────────────────────────────

  test("multiple subscribers receive the same event", () => {
    let count = 0;
    bus.on("SessionStopped", () => count++);
    bus.on("SessionStopped", () => count++);
    bus.on("SessionStopped", () => count++);

    bus.emit("SessionStopped", { sessionId: "s1" });
    expect(count).toBe(3);
  });

  // ── off (unsubscribe) ──────────────────────────────────────────────

  test("off removes subscriber", () => {
    let count = 0;
    const handler = () => { count++; };

    bus.on("SessionHeartbeat", handler);
    bus.emit("SessionHeartbeat", { sessionId: "s1", timestamp: "t1" });
    expect(count).toBe(1);

    bus.off("SessionHeartbeat", handler);
    bus.emit("SessionHeartbeat", { sessionId: "s2", timestamp: "t2" });
    expect(count).toBe(1); // Still 1 — handler was removed
  });

  // ── onAny / offAny (wildcard) ──────────────────────────────────────

  test("onAny receives all event types", () => {
    const received: string[] = [];
    bus.onAny((env) => received.push(env.event));

    bus.emit("SessionStarted", { sessionId: "s1" });
    bus.emit("SpecTransition", {
      project: "nx",
      specName: "spec-1",
      transition: "new_spec",
    });
    bus.emit("SessionStopped", { sessionId: "s1" });

    expect(received).toEqual(["SessionStarted", "SpecTransition", "SessionStopped"]);
  });

  test("offAny removes wildcard subscriber", () => {
    let count = 0;
    const handler = () => { count++; };

    bus.onAny(handler);
    bus.emit("SessionStarted", { sessionId: "s1" });
    expect(count).toBe(1);

    bus.offAny(handler);
    bus.emit("SessionStarted", { sessionId: "s2" });
    expect(count).toBe(1);
  });

  // ── Event isolation ────────────────────────────────────────────────

  test("subscriber only receives their event type", () => {
    let sessionCount = 0;
    let specCount = 0;

    bus.on("SessionStarted", () => sessionCount++);
    bus.on("SpecTransition", () => specCount++);

    bus.emit("SessionStarted", { sessionId: "s1" });
    bus.emit("SessionStarted", { sessionId: "s2" });
    bus.emit("SpecTransition", {
      project: "nx",
      specName: "spec-1",
      transition: "progress",
      completed: 3,
      total: 5,
    });

    expect(sessionCount).toBe(2);
    expect(specCount).toBe(1);
  });

  // ── Origin ─────────────────────────────────────────────────────────

  test("setOrigin attaches origin to emitted envelopes", () => {
    const received: LifecycleEnvelope[] = [];
    bus.onAny((env) => received.push(env));

    bus.setOrigin("omarchy");
    bus.emit("SessionStarted", { sessionId: "s1" });

    expect(received[0]!.origin).toBe("omarchy");
  });

  // ── removeAllListeners ─────────────────────────────────────────────

  test("removeAllListeners cleans up all subscriptions", () => {
    let count = 0;
    bus.on("SessionStarted", () => count++);
    bus.onAny(() => count++);

    bus.removeAllListeners();
    bus.emit("SessionStarted", { sessionId: "s1" });
    expect(count).toBe(0);
  });

  // ── Typed payloads ────────────────────────────────────────────────

  test("CredentialSwap event carries correct payload", () => {
    const received: LifecycleEnvelope<"CredentialSwap">[] = [];
    bus.on("CredentialSwap", (env) => received.push(env));

    bus.emit("CredentialSwap", {
      credentialId: "cred-1",
      reason: "rate-limited",
    });

    expect(received[0]!.payload.credentialId).toBe("cred-1");
    expect(received[0]!.payload.reason).toBe("rate-limited");
  });

  test("NotificationFired event carries correct payload", () => {
    const received: LifecycleEnvelope<"NotificationFired">[] = [];
    bus.on("NotificationFired", (env) => received.push(env));

    bus.emit("NotificationFired", {
      message: "Build complete",
      channel: "tts",
      project: "nx",
    });

    expect(received[0]!.payload.message).toBe("Build complete");
    expect(received[0]!.payload.channel).toBe("tts");
    expect(received[0]!.payload.project).toBe("nx");
  });
});
