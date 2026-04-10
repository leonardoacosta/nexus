import { describe, expect, it } from "bun:test";
import { expandTilde } from "./path";
import { homedir } from "node:os";
import { join } from "node:path";

describe("expandTilde", () => {
  it("expands bare ~ to homedir", () => {
    expect(expandTilde("~")).toBe(homedir());
  });

  it("expands ~/dev to homedir + /dev", () => {
    expect(expandTilde("~/dev")).toBe(join(homedir(), "dev"));
  });

  it("expands ~/nested/path correctly", () => {
    expect(expandTilde("~/a/b/c")).toBe(join(homedir(), "a/b/c"));
  });

  it("leaves absolute path unchanged", () => {
    expect(expandTilde("/abs/path")).toBe("/abs/path");
  });

  it("leaves empty string unchanged", () => {
    expect(expandTilde("")).toBe("");
  });

  it("leaves ~user form unchanged (unsupported)", () => {
    expect(expandTilde("~user")).toBe("~user");
  });

  it("leaves relative path without tilde unchanged", () => {
    expect(expandTilde("relative/path")).toBe("relative/path");
  });
});
