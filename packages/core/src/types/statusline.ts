/**
 * Wire types for the composed `GET /statusline` endpoint.
 *
 * `GET /statusline?sessionId=<id>&accountId=<id>` dispatches on which query
 * param is present (design.md "Response contract"):
 *
 *   | sessionId | accountId | Response                                        |
 *   |-----------|-----------|-------------------------------------------------|
 *   | absent    | absent    | `{ accounts: Account5H7D[] }` — all accounts     |
 *   | absent    | present   | `{ account: Account5H7D }` — one account (404)   |
 *   | present   | absent    | `{ session: SessionStatusResponse }` (404)       |
 *   | present   | present   | `400 { error: "...mutually exclusive" }`         |
 *
 * These types compose pre-existing shapes single-sourced elsewhere — `Account5H7D`
 * (`./account`) and `GitStatusObject` (`./git-status`) — plus the `GET /recommend`
 * response mirrored here as `NextRecommendation`.
 *
 * NAMING NOTE: the design.md interface named `SessionStatus` is exported here as
 * `SessionStatusResponse` because `SessionStatus` is already taken in
 * `./session` (the `sessions.status` enum union: "active" | "idle" | …). The
 * wire shape is exactly as design.md specifies; only the TypeScript identifier
 * differs to avoid the collision. The API batch (task 2.x) should import
 * `SessionStatusResponse` for the `{ session: … }` mode.
 *
 * Added by `redesign-status-usage-endpoints`.
 */

import type { Account5H7D } from "./account";
import type { GitStatusObject } from "./git-status";

/**
 * One recommendation entry — mirrors the `Recommendation` shape returned by the
 * existing `GET /recommend` handler (`apps/agent/src/routes/recommend.ts`).
 */
export interface NextRecommendationItem {
  id: string;
  title: string;
  score: number;
  reason: string;
  type: string;
}

/**
 * Context block on the `GET /recommend` response — mirrors `RecommendContext`
 * in `apps/agent/src/routes/recommend.ts`. Snake_case keys preserved as-is on
 * the wire.
 */
export interface NextRecommendationContext {
  project: string;
  active_spec: string | null;
  session_count: number;
}

/**
 * The full `GET /recommend` response shape, unchanged — composed into a
 * `SessionStatusResponse.next` field. Mirrors `RecommendResponse` in
 * `apps/agent/src/routes/recommend.ts`.
 */
export interface NextRecommendation {
  recommendations: NextRecommendationItem[];
  context: NextRecommendationContext;
}

/**
 * Composed single-session status for `GET /statusline?sessionId=<id>`
 * (the `{ session: … }` mode). Design.md names this interface `SessionStatus`;
 * it is exported as `SessionStatusResponse` here — see the file-level NAMING
 * NOTE for why.
 *
 * Fields:
 *   - `model`      — single-letter family tag from the existing
 *     `modelFamilyLetter()` helper; `null` when unknown.
 *   - `fiveHour`/`sevenDay` — the session's active-credential usage windows
 *     (resolved via `sessions.credentialId`), `null` when the credential is
 *     unresolved.
 *   - `usage`      — per-session cost/token breakdown (`readSessionCostTokens`);
 *     `cost_usd` is `null` when the telemetry VM is disabled.
 *   - `project`    — beads/openspec/git snapshot for the session's project,
 *     `null` when the session has no resolvable project.
 *   - `next`       — the `GET /recommend` payload, unchanged; `null` when
 *     unavailable.
 *   - `usedPercentage`/`contextWindowSize` — the session's context-window usage,
 *     derived agent-side from the transcript on every hook event (nx now owns
 *     this since CC removed its statusLine hook, cc 2a6eda0c). Both `null` when
 *     no fresh context entry exists (e.g. right after an agent restart, or a
 *     brand-new session with zero hook events yet).
 */
export interface SessionStatusResponse {
  sessionId: string;
  model: string | null;
  fiveHour: Account5H7D["fiveHour"] | null;
  sevenDay: Account5H7D["sevenDay"] | null;
  usage: {
    cost_usd: number | null;
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
  };
  project: {
    beadsReadyUnlinked: number;
    beadsBlockedUnlinked: number;
    proposalsUnarchived: number;
    git: GitStatusObject | null;
  } | null;
  next: NextRecommendation | null;
  usedPercentage: number | null;
  contextWindowSize: number | null;
}

/**
 * The composed `GET /statusline` response, discriminated by which key is
 * present — one member per row of the design.md 4-mode table.
 *
 * NOTE: per design.md, the neither-mode (`sessionId` + `accountId` both absent)
 * response is *additive* over today's all-active-sessions overview — the API
 * batch (task 2.1) preserves the existing `sessions[]`/`git`/`machine`/
 * `uptime_seconds` fields and MAY carry `accounts` alongside them. This union
 * models the narrowed contract shapes from the table; the full neither-mode
 * overview shape (with its legacy fields) is finalized by the API batch.
 */
export type StatuslineResponse =
  | { accounts: Account5H7D[] }
  | { account: Account5H7D }
  | { session: SessionStatusResponse }
  | { error: string };
