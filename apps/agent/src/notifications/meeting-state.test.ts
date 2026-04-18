/**
 * MeetingState invalid-transition tests.
 *
 * Pure logic — no DB or network required.
 */

import { describe, expect, it } from "bun:test";
import { MeetingState, InvalidStateError } from "./meeting-state";

describe("MeetingState: invalid transitions throw InvalidStateError", () => {
  it("double-start throws InvalidStateError", () => {
    const state = new MeetingState();
    state.start();

    expect(() => state.start()).toThrow(InvalidStateError);
  });

  it("double-start error message mentions 'already active'", () => {
    const state = new MeetingState();
    state.start();

    let caught: Error | undefined;
    try {
      state.start();
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.name).toBe("InvalidStateError");
    expect(caught!.message).toMatch(/already active/i);
  });

  it("end-without-start throws InvalidStateError", () => {
    const state = new MeetingState();

    expect(() => state.end()).toThrow(InvalidStateError);
  });

  it("end-without-start error message mentions 'no meeting active'", () => {
    const state = new MeetingState();

    let caught: Error | undefined;
    try {
      state.end();
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.name).toBe("InvalidStateError");
    expect(caught!.message).toMatch(/no meeting active/i);
  });

  it("start-end-start succeeds", () => {
    const state = new MeetingState();

    state.start();
    expect(state.active).toBe(true);

    state.end();
    expect(state.active).toBe(false);

    // Should not throw
    state.start();
    expect(state.active).toBe(true);
  });

  it("start-end-start leaves state consistent after second start", () => {
    const state = new MeetingState();

    state.start();
    const firstStartedAt = state.startedAt;
    expect(firstStartedAt).not.toBeNull();

    state.end();
    expect(state.startedAt).toBeNull();

    state.start();
    const secondStartedAt = state.startedAt;
    expect(secondStartedAt).not.toBeNull();
    // Second startedAt should be a valid ISO date string
    expect(() => new Date(secondStartedAt!)).not.toThrow();
  });
});
