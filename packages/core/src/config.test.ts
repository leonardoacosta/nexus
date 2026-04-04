import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig } from "./config";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "nexus-config-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeTmp(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe("parseConfig", () => {
  test("parses a valid config", () => {
    const path = writeTmp(
      "valid.toml",
      `
self_name = "omarchy"
role = "agent"
bind_address = "0.0.0.0"

[[agents]]
name = "omarchy"
host = "localhost"
port = 7400
user = "nyaptor"

[[agents]]
name = "macbook"
host = "macbook-pro"
port = 7400
user = "leonardoacosta"
`,
    );

    const result = parseConfig(path);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");

    expect(result.config.self_name).toBe("omarchy");
    expect(result.config.role).toBe("agent");
    expect(result.config.bind_address).toBe("0.0.0.0");
    expect(result.config.agents).toHaveLength(2);
    expect(result.config.agents[0]!.name).toBe("omarchy");
    expect(result.config.agents[0]!.port).toBe(7400);
    expect(result.config.agents[1]!.user).toBe("leonardoacosta");
  });

  test("parses config with optional fields omitted", () => {
    const path = writeTmp(
      "minimal.toml",
      `
self_name = "dev"

[[agents]]
name = "dev"
host = "127.0.0.1"
port = 7400
`,
    );

    const result = parseConfig(path);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");

    expect(result.config.role).toBeUndefined();
    expect(result.config.bind_address).toBeUndefined();
    expect(result.config.agents[0]!.user).toBeUndefined();
  });

  test("returns validation_error for missing required fields", () => {
    const path = writeTmp(
      "missing-fields.toml",
      `
role = "agent"

[[agents]]
name = "dev"
host = "localhost"
`,
    );

    const result = parseConfig(path);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");

    expect(result.error.type).toBe("validation_error");
    expect(result.error.details).toBeDefined();
    expect(result.error.details!.length).toBeGreaterThan(0);
  });

  test("returns toml_error for malformed TOML", () => {
    const path = writeTmp("bad.toml", `self_name = "unclosed`);

    const result = parseConfig(path);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");

    expect(result.error.type).toBe("toml_error");
    expect(result.error.message).toContain("Invalid TOML");
  });

  test("returns read_error for missing file", () => {
    const result = parseConfig(join(dir, "nonexistent.toml"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");

    expect(result.error.type).toBe("read_error");
  });

  test("returns validation_error when port is not a number", () => {
    const path = writeTmp(
      "bad-port.toml",
      `
self_name = "dev"

[[agents]]
name = "dev"
host = "localhost"
port = "not-a-number"
`,
    );

    const result = parseConfig(path);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");

    expect(result.error.type).toBe("validation_error");
  });
});
