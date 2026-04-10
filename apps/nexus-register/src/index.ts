#!/usr/bin/env bun
/**
 * nexus-register — Fast CLI for Claude Code session hooks.
 *
 * Usage:
 *   nexus-register start      Write session_start event
 *   nexus-register stop       Write session_end event
 *   nexus-register heartbeat  Write session_update event
 *
 * Environment:
 *   CLAUDE_SESSION_ID — Session ID (falls back to PID+CWD hash)
 */

import type { WatcherEvent } from "@nexus/core";
import { createLogger } from "@nexus/core";
import { detectProject, resolveSessionId } from "./detect";
import { writeEvent } from "./event-writer";

const log = createLogger("nexus-register");

const command = process.argv[2];

if (!command || !["start", "stop", "heartbeat"].includes(command)) {
  log.error("Usage: nexus-register <start|stop|heartbeat>");
  process.exit(1);
}

const sessionId = resolveSessionId();
const cwd = process.cwd();
const project = detectProject(cwd);

let event: WatcherEvent;

switch (command) {
  case "start":
    event = {
      type: "session_start",
      session_id: sessionId,
      project,
      path: cwd,
    };
    break;

  case "stop":
    event = {
      type: "session_end",
      session_id: sessionId,
    };
    break;

  case "heartbeat":
    event = {
      type: "session_update",
      session_id: sessionId,
      timestamp: new Date().toISOString(),
    };
    break;

  default:
    log.error({ command }, "Unknown command");
    process.exit(1);
}

await writeEvent(event);
