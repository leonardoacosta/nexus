import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:notifications:meeting-state");

/** Thrown when a meeting state transition is invalid. */
export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateError";
  }
}

/** The two states the meeting machine can occupy. */
export type MeetingStateName = "idle" | "active";

/** A transition request — the action a caller is attempting. */
export type MeetingTransition = "start" | "end";

/**
 * Legal transition set for the meeting state machine.
 *
 * Each entry maps a (current-state, transition) pair to the resulting state.
 * A pair absent from this table is an illegal transition and is rejected by
 * `assertTransition` below. Defining the set explicitly — rather than relying
 * on ad-hoc `if (this._inMeeting)` checks — gives a single source of truth for
 * what is and is not allowed, and makes the rejected-transition logging uniform.
 */
const LEGAL_TRANSITIONS: Record<
  MeetingStateName,
  Partial<Record<MeetingTransition, MeetingStateName>>
> = {
  idle: { start: "active" },
  active: { end: "idle" },
};

/** In-memory meeting state with manual toggle (calendar integration later). */
export class MeetingState {
  private _inMeeting = false;
  private _startedAt: string | null = null;

  /** Current state name derived from the internal flag. */
  private get _state(): MeetingStateName {
    return this._inMeeting ? "active" : "idle";
  }

  /**
   * Validate a transition against `LEGAL_TRANSITIONS`. On an illegal
   * transition, log at warn (so the rejection is observable, not silent) and
   * throw `InvalidStateError`. On a legal transition, return the resulting
   * state name.
   */
  private assertTransition(transition: MeetingTransition): MeetingStateName {
    const from = this._state;
    const to = LEGAL_TRANSITIONS[from][transition];
    if (to === undefined) {
      const message =
        transition === "start"
          ? "cannot start: meeting already active"
          : "cannot end: no meeting active";
      log.warn(
        { from, transition, startedAt: this._startedAt },
        `meeting-state: rejected invalid transition (${from} -> ${transition})`,
      );
      throw new InvalidStateError(message);
    }
    return to;
  }

  /** Start a meeting — notifications will be buffered. */
  start(): void {
    this.assertTransition("start");
    this._inMeeting = true;
    this._startedAt = new Date().toISOString();
    log.info({ startedAt: this._startedAt }, "meeting-state: started");
  }

  /** End the current meeting — triggers flush of buffered notifications. */
  end(): void {
    this.assertTransition("end");
    this._inMeeting = false;
    this._startedAt = null;
    log.info("meeting-state: ended");
  }

  /** Whether a meeting is currently active. */
  get active(): boolean {
    return this._inMeeting;
  }

  /** When the current meeting started, or null. */
  get startedAt(): string | null {
    return this._startedAt;
  }

  /** Current status as a plain object (for API responses). */
  status(): { active: boolean; started_at: string | null } {
    return { active: this._inMeeting, started_at: this._startedAt };
  }
}
