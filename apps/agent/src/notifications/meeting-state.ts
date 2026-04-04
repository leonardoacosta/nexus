/** In-memory meeting state with manual toggle (calendar integration later). */
export class MeetingState {
  private _inMeeting = false;
  private _startedAt: string | null = null;

  /** Start a meeting — notifications will be buffered. */
  start(): void {
    this._inMeeting = true;
    this._startedAt = new Date().toISOString();
  }

  /** End the current meeting — triggers flush of buffered notifications. */
  end(): void {
    this._inMeeting = false;
    this._startedAt = null;
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
