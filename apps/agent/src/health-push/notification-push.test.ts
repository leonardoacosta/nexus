import { describe, expect, it } from "bun:test";

import { composeTitle } from "./notification-push";

// ── 1.3 composeTitle — `project · session` banner title rule ──────────────────
//
// Runtime evidence for the title rule (notification-fidelity task 1.3) until
// APNS provisioning (nx-gsgvk) lands. MIDDOT separator is U+00B7.

describe("composeTitle (task 1.3)", () => {
  it("joins project and session with a middot when both present", () => {
    expect(composeTitle("oo", "fix-login-flow")).toBe("oo · fix-login-flow");
  });

  it("returns the session alone when only the session is present", () => {
    expect(composeTitle(undefined, "fix-login-flow")).toBe("fix-login-flow");
  });

  it("returns the project alone when only the project is present", () => {
    expect(composeTitle("oo", undefined)).toBe("oo");
  });

  it('falls back to "Nexus" when neither project nor session is present', () => {
    expect(composeTitle()).toBe("Nexus");
  });

  it("uses the caller-supplied fallback before the generic default", () => {
    expect(composeTitle(undefined, undefined, "Heartbeat")).toBe("Heartbeat");
  });

  it("treats whitespace-only project/session as absent", () => {
    // Both whitespace -> neither present -> generic fallback.
    expect(composeTitle("   ", "\t")).toBe("Nexus");
    // Whitespace project + real session -> session alone (no separator).
    expect(composeTitle("  ", "fix-login-flow")).toBe("fix-login-flow");
    // Real project + whitespace session -> project alone (no separator).
    expect(composeTitle("oo", "   ")).toBe("oo");
  });

  it("trims surrounding whitespace before composing", () => {
    expect(composeTitle("  oo  ", "  fix-login-flow  ")).toBe(
      "oo · fix-login-flow",
    );
  });
});
