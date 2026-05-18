/**
 * Unit tests for git-project URL parsing. Exercises the 3 canonical forms
 * plus rejection paths (non-git, malformed, single-segment path).
 */

import { describe, expect, it } from "bun:test";

import { parseOriginUrl, resolveGitOrigin } from "./git-project";

describe("parseOriginUrl", () => {
  it("parses SSH form", () => {
    expect(parseOriginUrl("git@github.com:leonardoacosta/nexus.git")).toEqual({
      provider: "github.com",
      ownerRepo: "leonardoacosta/nexus",
    });
  });

  it("parses HTTPS form", () => {
    expect(
      parseOriginUrl("https://github.com/leonardoacosta/nexus.git"),
    ).toEqual({
      provider: "github.com",
      ownerRepo: "leonardoacosta/nexus",
    });
  });

  it("parses git:// form without .git suffix", () => {
    expect(parseOriginUrl("git://github.com/leonardoacosta/nexus")).toEqual({
      provider: "github.com",
      ownerRepo: "leonardoacosta/nexus",
    });
  });

  it("handles GitLab nested subgroups by coalescing to first two segments", () => {
    expect(
      parseOriginUrl(
        "https://gitlab.com/acme/platform/api/payments.git",
      ),
    ).toEqual({
      provider: "gitlab.com",
      ownerRepo: "acme/platform",
    });
  });

  it("returns null for empty input", () => {
    expect(parseOriginUrl("")).toBeNull();
  });

  it("returns null for single-segment paths", () => {
    expect(parseOriginUrl("https://github.com/nexus.git")).toBeNull();
  });

  it("returns null for malformed urls", () => {
    expect(parseOriginUrl("not-a-valid-url-string")).toBeNull();
  });

  it("returns null for SSH form without ownerRepo segment", () => {
    expect(parseOriginUrl("git@github.com:nexus")).toBeNull();
  });
});

describe("resolveGitOrigin", () => {
  it("returns null for non-existent cwd", async () => {
    expect(await resolveGitOrigin("/nonexistent-path-1234")).toBeNull();
  });

  it("returns null for null cwd", async () => {
    expect(await resolveGitOrigin(null)).toBeNull();
    expect(await resolveGitOrigin(undefined)).toBeNull();
  });
});
