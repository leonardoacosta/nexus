/**
 * Event file writer.
 *
 * Writes JSON event files to `~/.config/nexus/events/` for the
 * Rust file watcher to pick up. Each file is named
 * `{timestamp}-{session_id}.json` to guarantee uniqueness and ordering.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { WatcherEvent } from "@nexus/core";

const EVENTS_DIR = join(homedir(), ".config", "nexus", "events");

/** Ensure the events directory exists (sync for speed — single mkdir). */
export function ensureEventsDir(): void {
  mkdirSync(EVENTS_DIR, { recursive: true });
}

/**
 * Write a WatcherEvent as a JSON file to the events directory.
 * Filename: `{epoch_ms}-{session_id}.json`
 */
export function writeEvent(event: WatcherEvent): void {
  ensureEventsDir();

  const timestamp = Date.now();
  const sessionId = event.session_id;
  const filename = `${timestamp}-${sessionId}.json`;
  const filepath = join(EVENTS_DIR, filename);

  writeFileSync(filepath, JSON.stringify(event) + "\n", "utf-8");
}

/** Expose EVENTS_DIR for testing. */
export { EVENTS_DIR };
