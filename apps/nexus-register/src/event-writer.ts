/**
 * Event file writer.
 *
 * Writes JSON event files to `~/.config/nexus/events/` for the
 * Rust file watcher to pick up. Each file is named
 * `{timestamp}-{session_id}.json` to guarantee uniqueness and ordering.
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { WatcherEvent } from "@nexus/core";

const EVENTS_DIR = join(homedir(), ".config", "nexus", "events");

/** Ensure the events directory exists. */
export async function ensureEventsDir(): Promise<void> {
  await mkdir(EVENTS_DIR, { recursive: true });
}

/**
 * Write a WatcherEvent as a JSON file to the events directory.
 * Filename: `{epoch_ms}-{session_id}.json`
 */
export async function writeEvent(event: WatcherEvent): Promise<void> {
  await ensureEventsDir();

  const timestamp = Date.now();
  const sessionId = event.session_id;
  const filename = `${timestamp}-${sessionId}.json`;
  const filepath = join(EVENTS_DIR, filename);

  await writeFile(filepath, JSON.stringify(event) + "\n", "utf-8");
}

/** Expose EVENTS_DIR for testing. */
export { EVENTS_DIR };
