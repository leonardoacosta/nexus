/**
 * Unit tests for the hook → agentState derivation (session-enrichment).
 *
 * Covers `deriveAgentState` (pure mapping, no DB) for all four lifecycle
 * transitions plus the round-trip narrowing helper in `@nexus/core`:
 *   - PreToolUse / PostToolUse / UserPromptSubmit / SubagentStart  → blocked
 *   - Notification (awaiting input)                               → waiting
 *   - Stop                                                        → ready
 *   - snake_case socket aliases (session_heartbeat/notification/session_stop)
 *   - non-signal events (session_start, agent_spawn, telemetry)  → null
 *
 * No DB is required — `deriveAgentState` is a pure function. The persistence
 * path (`updateSessionAgentState`) is exercised indirectly by
 * `process-hook-event.test.ts` (which mocks the writer) and the DB integration
 * suite; this file pins the mapping contract that both rely on.
 */

import { describe, test, expect } from "bun:test";
import { deriveAgentState } from "./sessions";
import { narrowAgentState } from "@nexus/core";

describe("deriveAgentState — hook → agentState mapping", () => {
  test("PreToolUse marks the session blocked", () => {
    expect(deriveAgentState("PreToolUse")).toBe("blocked");
  });

  test("PostToolUse marks the session blocked", () => {
    expect(deriveAgentState("PostToolUse")).toBe("blocked");
  });

  test("UserPromptSubmit marks the session blocked", () => {
    expect(deriveAgentState("UserPromptSubmit")).toBe("blocked");
  });

  test("SubagentStart marks the session blocked", () => {
    expect(deriveAgentState("SubagentStart")).toBe("blocked");
  });

  test("Notification (awaiting input) marks the session waiting", () => {
    expect(deriveAgentState("Notification")).toBe("waiting");
  });

  test("Stop marks the session ready", () => {
    expect(deriveAgentState("Stop")).toBe("ready");
  });

  test("snake_case socket aliases map identically to their CC names", () => {
    // The dispatcher feeds the agent's snake_case socket-event names; they must
    // resolve to the same state as the canonical CC hook names.
    expect(deriveAgentState("session_heartbeat")).toBe("blocked");
    expect(deriveAgentState("notification")).toBe("waiting");
    expect(deriveAgentState("session_stop")).toBe("ready");
  });

  test("non-signal events return null (no clobber)", () => {
    // These events carry no agent-state signal — the caller MUST skip the
    // persist so a previously-derived state is never overwritten with null.
    expect(deriveAgentState("session_start")).toBeNull();
    expect(deriveAgentState("agent_spawn")).toBeNull();
    expect(deriveAgentState("telemetry")).toBeNull();
    expect(deriveAgentState("totally_unknown")).toBeNull();
  });
});

describe("narrowAgentState — DB string → AgentState | null", () => {
  test("narrows each valid value", () => {
    expect(narrowAgentState("blocked")).toBe("blocked");
    expect(narrowAgentState("waiting")).toBe("waiting");
    expect(narrowAgentState("ready")).toBe("ready");
  });

  test("null / undefined preserve null (no hook observed yet)", () => {
    expect(narrowAgentState(null)).toBeNull();
    expect(narrowAgentState(undefined)).toBeNull();
  });

  test("unknown non-null values degrade to null instead of throwing", () => {
    // agentState is a soft display signal — enum drift from an old agent must
    // NOT break a sessions query (unlike status, which throws).
    expect(narrowAgentState("active")).toBeNull();
    expect(narrowAgentState("garbage")).toBeNull();
  });
});
