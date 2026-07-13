/**
 * Unit tests for the shared `modelFamilyLetter` mapping
 * (add-session-model-authority). Ported from the existing coverage in
 * `apps/nexus-statusline/src/index.test.ts` (family substring match,
 * unknown-family fallback, no-model → null), now exercised against the
 * canonical `@nexus/core` module location.
 */

import { describe, test, expect } from "bun:test";
import { modelFamilyLetter } from "./model-letter";

describe("modelFamilyLetter — family substring match", () => {
  test("fable → F", () => {
    expect(modelFamilyLetter({ id: "claude-fable-5" })).toBe("F");
  });

  test("opus → O (matches on id)", () => {
    expect(modelFamilyLetter({ id: "claude-opus-4-8" })).toBe("O");
  });

  test("sonnet → S (matches on id or display_name)", () => {
    expect(
      modelFamilyLetter({ id: "claude-sonnet-4-6", display_name: "Sonnet 4.6" }),
    ).toBe("S");
    // Match via display_name alone (id absent).
    expect(modelFamilyLetter({ display_name: "Sonnet 4.6" })).toBe("S");
  });

  test("haiku → H", () => {
    expect(modelFamilyLetter({ id: "claude-haiku-4-5" })).toBe("H");
  });
});

describe("modelFamilyLetter — unknown family fallback", () => {
  test("uppercased display_name initial for an unknown family", () => {
    expect(modelFamilyLetter({ id: "nova-x1", display_name: "Nova X1" })).toBe("N");
  });

  test("falls back to id initial when display_name is absent", () => {
    expect(modelFamilyLetter({ id: "zephyr-1" })).toBe("Z");
  });
});

describe("modelFamilyLetter — no model → null", () => {
  test("undefined model → null", () => {
    expect(modelFamilyLetter(undefined)).toBeNull();
  });

  test("empty object (no id, no display_name) → null", () => {
    expect(modelFamilyLetter({})).toBeNull();
  });

  test("both fields empty strings → null", () => {
    expect(modelFamilyLetter({ id: "", display_name: "" })).toBeNull();
  });
});
