import { describe, expect, test } from "bun:test";
import { isUnspeakable, stripBeadIds } from "./speakability";

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

describe("stripBeadIds", () => {
  test("strips a single bead ID", () => {
    expect(stripBeadIds("fixed nx-2g2j4 and shipped")).toBe("fixed and shipped");
  });

  test("strips multiple bead IDs", () => {
    expect(stripBeadIds("close nx-abc12 then nx-def34 today")).toBe(
      "close then today",
    );
  });

  test("strips a bracketed list cleanly (brackets collapse away)", () => {
    expect(stripBeadIds("done [nx-2g2j4 nx-lvyu9]")).toBe("done");
    expect(stripBeadIds("[nx-2g2j4 nx-lvyu9]")).toBe("");
  });

  test("strips a slash-separated list cleanly", () => {
    expect(stripBeadIds("close nx-2b9k8/nx-2pekj/nx-p9gk4 done")).toBe(
      "close done",
    );
  });

  test("strips an ID at the start of the body", () => {
    expect(stripBeadIds("nx-2g2j4 fixed the bug")).toBe("fixed the bug");
  });

  test("strips an ID at the end of the body", () => {
    expect(stripBeadIds("shipped the fix nx-2g2j4")).toBe("shipped the fix");
  });

  test("strips the cc- tracker prefix too", () => {
    expect(stripBeadIds("merged cc-lvyu9 to main")).toBe("merged to main");
  });

  test("does NOT over-strip a normal sentence with no bead IDs", () => {
    expect(stripBeadIds("build done, all green")).toBe("build done, all green");
    // Hyphenated words that merely look ID-shaped must survive.
    expect(stripBeadIds("re-run the e2e suite")).toBe("re-run the e2e suite");
    // Unknown prefix is not in the allowlist — left untouched.
    expect(stripBeadIds("see oo-2g2j4 for context")).toBe(
      "see oo-2g2j4 for context",
    );
  });

  test("SPOKEN path strips while the persisted body is retained", () => {
    // Simulates the router seam: notification.body is the persisted/banner
    // value (full ID kept); the spoken text is the stripped derivative.
    const persistedBody = "closed nx-gnpdy and nx-2pekj [session]";
    const spokenText = stripBeadIds(persistedBody);

    expect(spokenText).toBe("closed and [session]");
    // The persisted body is never mutated — IDs survive for banner + history.
    expect(persistedBody).toBe("closed nx-gnpdy and nx-2pekj [session]");
    expect(persistedBody).toContain("nx-gnpdy");
    expect(spokenText).not.toContain("nx-gnpdy");
    expect(spokenText).not.toContain("nx-2pekj");
  });
});
