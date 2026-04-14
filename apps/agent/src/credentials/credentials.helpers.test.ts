/**
 * Unit tests for computeCredentialFingerprint helper.
 *
 * Verifies deterministic SHA-256 output from OAuth refresh tokens,
 * collision resistance, and typed error handling for malformed inputs.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  computeCredentialFingerprint,
  CredentialParseError,
} from "./credentials.helpers";

const validPayload = JSON.stringify({
  claudeAiOauth: {
    accessToken: "sk-ant-oat01-test",
    refreshToken: "sk-ant-ort01-test-refresh-token",
    expiresAt: 1775033611232,
    scopes: ["user:inference"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  },
});

const expectedFingerprint = createHash("sha256")
  .update("sk-ant-ort01-test-refresh-token")
  .digest("hex");

describe("computeCredentialFingerprint", () => {
  it("returns deterministic SHA-256 hex for valid OAuth JSON", () => {
    const result = computeCredentialFingerprint(validPayload);
    expect(result).toBe(expectedFingerprint);
    // SHA-256 hex is 64 characters
    expect(result).toHaveLength(64);
    // All lowercase hex
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns same hash for identical tokens (determinism check)", () => {
    const a = computeCredentialFingerprint(validPayload);
    const b = computeCredentialFingerprint(validPayload);
    expect(a).toBe(b);
  });

  it("returns different hashes for different tokens (collision check)", () => {
    const otherPayload = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-other",
        refreshToken: "sk-ant-ort01-DIFFERENT-token",
        expiresAt: 1775033611232,
        scopes: ["user:inference"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      },
    });
    const a = computeCredentialFingerprint(validPayload);
    const b = computeCredentialFingerprint(otherPayload);
    expect(a).not.toBe(b);
  });

  it("throws CredentialParseError when claudeAiOauth key is missing", () => {
    const payload = JSON.stringify({ someOtherKey: "value" });
    expect(() => computeCredentialFingerprint(payload)).toThrow(
      CredentialParseError,
    );
    try {
      computeCredentialFingerprint(payload);
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialParseError);
      expect((err as CredentialParseError).code).toBe(
        "CREDENTIAL_PARSE_ERROR",
      );
      expect((err as CredentialParseError).message).toContain(
        "claudeAiOauth",
      );
    }
  });

  it("throws CredentialParseError when refreshToken key is missing", () => {
    const payload = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-test",
        // refreshToken intentionally absent
        expiresAt: 1775033611232,
      },
    });
    expect(() => computeCredentialFingerprint(payload)).toThrow(
      CredentialParseError,
    );
    try {
      computeCredentialFingerprint(payload);
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialParseError);
      expect((err as CredentialParseError).message).toContain(
        "refreshToken",
      );
    }
  });

  it("throws CredentialParseError for non-JSON input (plain string)", () => {
    expect(() => computeCredentialFingerprint("not json at all")).toThrow(
      CredentialParseError,
    );
    try {
      computeCredentialFingerprint("not json at all");
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialParseError);
      expect((err as CredentialParseError).message).toContain("not valid JSON");
    }
  });

  it("throws CredentialParseError for empty string input", () => {
    expect(() => computeCredentialFingerprint("")).toThrow(
      CredentialParseError,
    );
  });
});
