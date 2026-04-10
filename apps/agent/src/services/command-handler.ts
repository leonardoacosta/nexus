/**
 * CommandHandler -- handles SocketCommand messages from the Unix socket.
 *
 * Each command receives a typed request and returns a SocketResponse.
 * Manages notification mode state (mode query/set/cycle), notification
 * history, type overrides, and per-project notification rules.
 */

import { createLogger } from "@nexus/core";
import type {
  SocketCommand,
  SocketResponse,
} from "../types/socket-events";

const log = createLogger("agent:command-handler");

// ---------------------------------------------------------------------------
// Notification mode state
// ---------------------------------------------------------------------------

/** Available notification modes. */
const MODES = ["full", "system", "noduck", "silent"] as const;
type Mode = (typeof MODES)[number];

/** Current global notification mode. */
let currentMode: Mode = "full";

/** Per-type mode overrides (bounded to prevent unbounded growth). */
const MAX_TYPE_OVERRIDES = 500;
const typeOverrides = new Map<string, Mode>();

/** Recent notification history (ring buffer). */
const MAX_HISTORY = 100;
const notificationHistory: Array<{
  timestamp: string;
  message: string;
  messageType?: string;
  channels?: string[];
  project?: string;
}> = [];

/** Per-project notification rules. */
interface ProjectRules {
  verbosity: string;
  announce_agents: boolean;
  announce_specs: boolean;
  announce_sessions: boolean;
}

const defaultRules: ProjectRules = {
  verbosity: "brief",
  announce_agents: true,
  announce_specs: true,
  announce_sessions: true,
};

const MAX_PROJECT_RULES = 500;
const projectRules = new Map<string, ProjectRules>();

// ---------------------------------------------------------------------------
// Public API -- record notification for history
// ---------------------------------------------------------------------------

/**
 * Record a notification in the history buffer.
 * Called by the socket event dispatcher when a Notification event arrives.
 */
export function recordNotification(
  message: string,
  messageType?: string,
  channels?: string[],
  project?: string,
): void {
  if (notificationHistory.length >= MAX_HISTORY) {
    notificationHistory.shift();
  }
  notificationHistory.push({
    timestamp: new Date().toISOString(),
    message,
    messageType,
    channels,
    project,
  });
}

/** Get the current notification mode. */
export function getCurrentMode(): Mode {
  return currentMode;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Dispatch a SocketCommand and return the appropriate SocketResponse.
 */
export function handleCommand(command: SocketCommand): SocketResponse {
  switch (command.command) {
    case "mode_query": {
      log.debug("command: mode_query");
      return { mode: currentMode };
    }

    case "mode_set": {
      const previous = currentMode;
      const newMode = MODES.includes(command.mode as Mode)
        ? (command.mode as Mode)
        : "full";
      currentMode = newMode;
      log.info({ mode: newMode, previous }, "command: mode_set");
      return { mode: currentMode, previous };
    }

    case "mode_cycle": {
      const previous = currentMode;
      const idx = MODES.indexOf(currentMode);
      currentMode = MODES[(idx + 1) % MODES.length]!;
      log.info({ mode: currentMode, previous }, "command: mode_cycle");
      return { mode: currentMode, previous };
    }

    case "history": {
      const limit = command.limit ?? MAX_HISTORY;
      const items = notificationHistory.slice(-limit);
      log.debug({ limit, returned: items.length }, "command: history");
      return { items };
    }

    case "type_set": {
      const mode = MODES.includes(command.mode as Mode)
        ? (command.mode as Mode)
        : "full";
      // Max-size guard: evict oldest entry when at capacity
      if (typeOverrides.size >= MAX_TYPE_OVERRIDES && !typeOverrides.has(command.name)) {
        const firstKey = typeOverrides.keys().next().value;
        if (firstKey !== undefined) typeOverrides.delete(firstKey);
      }
      typeOverrides.set(command.name, mode);
      log.info({ typeName: command.name, mode }, "command: type_set");
      return { type: command.name, mode };
    }

    case "type_clear": {
      typeOverrides.delete(command.name);
      log.info({ typeName: command.name }, "command: type_clear");
      return { cleared: command.name };
    }

    case "notification_rules": {
      const project = command.project ?? "";
      log.debug({ project }, "command: notification_rules");
      const rules = project
        ? projectRules.get(project) ?? { ...defaultRules }
        : { ...defaultRules };
      return rules as unknown as SocketResponse;
    }

    case "notification_set": {
      const { project } = command;
      log.info(
        {
          project,
          verbosity: command.verbosity,
          announceAgents: command.announce_agents,
          announceSpecs: command.announce_specs,
          announceSessions: command.announce_sessions,
          resetToDefault: command.reset_to_default,
        },
        "command: notification_set",
      );

      if (command.reset_to_default) {
        projectRules.delete(project);
        return { ok: true, project };
      }

      if (project === "") {
        // Update defaults.
        if (command.verbosity) defaultRules.verbosity = command.verbosity;
        if (command.announce_agents !== undefined) defaultRules.announce_agents = command.announce_agents;
        if (command.announce_specs !== undefined) defaultRules.announce_specs = command.announce_specs;
        if (command.announce_sessions !== undefined) defaultRules.announce_sessions = command.announce_sessions;
      } else {
        // Get or create project rules based on current defaults.
        let rules = projectRules.get(project);
        if (!rules) {
          // Max-size guard: evict oldest entry when at capacity
          if (projectRules.size >= MAX_PROJECT_RULES) {
            const firstKey = projectRules.keys().next().value;
            if (firstKey !== undefined) projectRules.delete(firstKey);
          }
          rules = { ...defaultRules };
          projectRules.set(project, rules);
        }
        if (command.verbosity) rules.verbosity = command.verbosity;
        if (command.announce_agents !== undefined) rules.announce_agents = command.announce_agents;
        if (command.announce_specs !== undefined) rules.announce_specs = command.announce_specs;
        if (command.announce_sessions !== undefined) rules.announce_sessions = command.announce_sessions;
      }

      return { ok: true, project };
    }

    default: {
      log.warn({ command }, "command: unknown command");
      return { error: "unknown command" };
    }
  }
}
