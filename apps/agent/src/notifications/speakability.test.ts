import { describe, expect, test } from "bun:test";
import { isUnspeakable } from "./speakability";

describe("isUnspeakable", () => {
  test("returns true for an absolute path with extension", () => {
    expect(
      isUnspeakable("/home/nyaptor/dev/oo/docs/screenshots/img-20260502-171247.png"),
    ).toBe(true);
  });

  test("returns true for a tilde-prefixed path", () => {
    expect(isUnspeakable("~/Downloads/screenshot.png")).toBe(true);
  });

  test("returns true for a relative ./ path", () => {
    expect(isUnspeakable("./out/build.log")).toBe(true);
  });

  test("returns true for a relative ../ path", () => {
    expect(isUnspeakable("../sibling/foo.txt")).toBe(true);
  });

  test("returns true for empty / whitespace-only body", () => {
    expect(isUnspeakable("")).toBe(true);
    expect(isUnspeakable("   ")).toBe(true);
  });

  test("returns true for a sentence mentioning an image extension (Option B)", () => {
    expect(isUnspeakable("Saved screenshot to /tmp/foo.png")).toBe(true);
    expect(isUnspeakable("attached: hero.jpg")).toBe(true);
    expect(isUnspeakable("rendered video.mp4")).toBe(true);
  });

  test("returns true for a body mentioning 'ghosty' (any case)", () => {
    expect(isUnspeakable("ghosty session started")).toBe(true);
    expect(isUnspeakable("Ghosty: build done")).toBe(true);
    expect(isUnspeakable("attached to GHOSTY")).toBe(true);
  });

  test("returns false for unrelated tokens that share a substring", () => {
    // Word-boundary guard means we don't false-positive on similar names.
    expect(isUnspeakable("ghostbuster online")).toBe(false);
  });

  test("returns false for a normal status message", () => {
    expect(isUnspeakable("build done")).toBe(false);
  });

  test("returns false for a path-shaped string without extension", () => {
    // A bare directory mention shouldn't be silenced — could be intentional.
    expect(isUnspeakable("/usr/local/bin")).toBe(false);
  });

  test("returns false for a project: prefixed status", () => {
    expect(isUnspeakable("oo: deploy succeeded")).toBe(false);
  });
});
