import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchConfig } from "./config-watcher";
import type { NexusConfig } from "@nexus/core/node";

const VALID_CONFIG = `
self_name = "omarchy"

[[agents]]
name = "omarchy"
host = "localhost"
port = 7400
`;

const UPDATED_CONFIG = `
self_name = "updated"

[[agents]]
name = "updated"
host = "192.168.1.1"
port = 8000
`;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "nexus-watcher-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("watchConfig", () => {
  test("fires onChange with parsed config when file changes", async () => {
    const configPath = join(dir, "watch-test.toml");
    writeFileSync(configPath, VALID_CONFIG);

    const received: NexusConfig[] = [];

    const stop = watchConfig(configPath, (config) => {
      received.push(config);
    });

    // Wait a tick so the watcher is fully set up
    await new Promise((r) => setTimeout(r, 100));

    // Trigger a change
    writeFileSync(configPath, UPDATED_CONFIG);

    // Wait for debounce (500ms) + margin
    await new Promise((r) => setTimeout(r, 800));

    stop();

    expect(received.length).toBeGreaterThanOrEqual(1);
    const last = received[received.length - 1]!;
    expect(last.self_name).toBe("updated");
    expect(last.agents[0]!.name).toBe("updated");
    expect(last.agents[0]!.port).toBe(8000);
  });

  test("does not fire onChange for invalid config", async () => {
    const configPath = join(dir, "watch-invalid.toml");
    writeFileSync(configPath, VALID_CONFIG);

    const received: NexusConfig[] = [];

    const stop = watchConfig(configPath, (config) => {
      received.push(config);
    });

    await new Promise((r) => setTimeout(r, 100));

    // Write invalid TOML
    writeFileSync(configPath, `self_name = "unclosed`);

    // Wait for debounce + margin
    await new Promise((r) => setTimeout(r, 800));

    stop();

    // Should have 0 calls — invalid config is silently skipped
    expect(received).toHaveLength(0);
  });

  test("debounces rapid writes into a single callback", async () => {
    const configPath = join(dir, "watch-debounce.toml");
    writeFileSync(configPath, VALID_CONFIG);

    const received: NexusConfig[] = [];

    const stop = watchConfig(configPath, (config) => {
      received.push(config);
    });

    await new Promise((r) => setTimeout(r, 100));

    // Rapid-fire 5 writes within 200ms
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        configPath,
        `
self_name = "rapid-${i}"

[[agents]]
name = "rapid-${i}"
host = "localhost"
port = ${7400 + i}
`,
      );
      await new Promise((r) => setTimeout(r, 40));
    }

    // Wait for debounce to settle
    await new Promise((r) => setTimeout(r, 800));

    stop();

    // Debounce should collapse rapid writes — expect 1 (or at most 2) callbacks
    expect(received.length).toBeLessThanOrEqual(2);
    expect(received.length).toBeGreaterThanOrEqual(1);

    // The last config received should be the final write
    const last = received[received.length - 1]!;
    expect(last.self_name).toBe("rapid-4");
  });
});
