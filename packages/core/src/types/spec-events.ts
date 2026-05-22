/**
 * Spec lifecycle event + SSE framing types shared by agent and client.
 *
 * The agent emits `SpecTransitionEvent`s on `lifecycleBus` and flushes
 * coalesced batches to the `/specs/events` SSE stream. The Next.js specs
 * page subscribes via `EventSource` and re-renders affected rows.
 *
 * Discriminated-union on `kind`:
 *   - `new`        — a new change directory appeared
 *   - `progress`   — task completion count advanced
 *   - `complete`   — all tasks for a change are checked
 *   - `archived`   — change was removed from `openspec/changes/`
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// SpecTransitionEvent (application-level)
// ---------------------------------------------------------------------------

export type SpecTransitionKind =
  | "new"
  | "progress"
  | "complete"
  | "archived"
  // `status_change` — frontmatter status flipped via PATCH /specs/.../status
  // (specs-tab-start-on-spec). Carries the post-flip status so the
  // dashboard can reconcile its row pill without a refetch.
  | "status_change";

export interface SpecTransitionEventBase {
  /** Project code (e.g. `nx`, `oo`). */
  project: string;
  /** Change directory name (e.g. `add-spec-page-live-updates`). */
  spec: string;
}

export interface SpecTransitionNewEvent extends SpecTransitionEventBase {
  kind: "new";
}

export interface SpecTransitionProgressEvent extends SpecTransitionEventBase {
  kind: "progress";
  completed: number;
  total: number;
}

export interface SpecTransitionCompleteEvent extends SpecTransitionEventBase {
  kind: "complete";
}

export interface SpecTransitionArchivedEvent extends SpecTransitionEventBase {
  kind: "archived";
}

export interface SpecTransitionStatusChangeEvent
  extends SpecTransitionEventBase {
  kind: "status_change";
  to: "draft" | "approved";
}

export type SpecTransitionEvent =
  | SpecTransitionNewEvent
  | SpecTransitionProgressEvent
  | SpecTransitionCompleteEvent
  | SpecTransitionArchivedEvent
  | SpecTransitionStatusChangeEvent;

// ---------------------------------------------------------------------------
// SSE wire framing
// ---------------------------------------------------------------------------

/**
 * Shape of the JSON payload embedded in each SSE `data:` line on
 * `GET /specs/events`. The stream also emits occasional heartbeat
 * comments (`: keepalive`) that are not SSE messages and therefore not
 * described by this schema.
 */
export const specEventsFrameSchema = z.object({
  /** Monotonic frame counter (resets per connection). */
  seq: z.number().int().nonnegative(),
  /** ISO-8601 timestamp at flush time. */
  ts: z.string(),
  /** One-or-more events coalesced into a single flush. */
  events: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("new"),
        project: z.string(),
        spec: z.string(),
      }),
      z.object({
        kind: z.literal("progress"),
        project: z.string(),
        spec: z.string(),
        completed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      }),
      z.object({
        kind: z.literal("complete"),
        project: z.string(),
        spec: z.string(),
      }),
      z.object({
        kind: z.literal("archived"),
        project: z.string(),
        spec: z.string(),
      }),
      z.object({
        kind: z.literal("status_change"),
        project: z.string(),
        spec: z.string(),
        to: z.enum(["draft", "approved"]),
      }),
    ]),
  ),
});

export type SpecEventsFrame = z.infer<typeof specEventsFrameSchema>;

/** SSE event name clients should listen for: `event: spec-transition`. */
export const SPEC_EVENTS_EVENT_NAME = "spec-transition" as const;
