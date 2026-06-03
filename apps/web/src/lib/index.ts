/**
 * Public client surface for the Nexus web app. The UI batch imports from here.
 *
 * - Transport (renderer-agnostic): {@link AgentSessionClient} / {@link attachSession}
 *   expose bytes / geometry / status callbacks + input/resize. They do NOT
 *   import `@wterm/*`; the UI wires `onBytes` -> `core.writeRaw`,
 *   `onGeometry` -> `core.resize`, and `core.getResponse()` -> `sendInput`.
 * - REST: {@link AgentRestClient} / {@link pollSessions} drive the session list
 *   and creation.
 * - Config: {@link getAgentBaseUrl} / {@link isAgentConfigured} gate the UI on
 *   `NEXT_PUBLIC_NEXUS_AGENT_URL`.
 */

export {
  getAgentBaseUrl,
  isAgentConfigured,
  toWsUrl,
  toHttpUrl,
} from "./agent-config";

export {
  AgentSessionClient,
  attachSession,
} from "./agent-ws-client";
export type {
  ConnectionStatus,
  Geometry,
  AgentStreamHandlers,
  AgentSessionClientOptions,
} from "./agent-ws-client";

export {
  AgentRestClient,
  AgentHttpError,
  pollSessions,
} from "./agent-rest-client";
export type {
  SessionSummary,
  StartSessionResult,
  StartSessionInput,
  ListSessionsOptions,
  SessionPoll,
} from "./agent-rest-client";
