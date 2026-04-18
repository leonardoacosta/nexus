/**
 * UsageCell component tests.
 *
 * Covers SpecA 5.3 (nx-uc44): when `usagePercent` is a number the cell must
 * render a "percent" view; when null, it must render a muted "not polled yet"
 * fallback.
 *
 * The distinction matters because "0% usage" and "we don't have data yet"
 * look identical if we collapse nulls to 0 — operators couldn't tell whether
 * an account is truly idle or whether the Anthropic usage poller simply
 * hasn't reached it yet.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { UsageCell } from "../usage-cell";

describe("UsageCell", () => {
  // Vitest 4 + RTL no longer auto-cleans between tests — explicit cleanup
  // ensures a stale "not polled yet" span from the first test does not
  // leak into the subsequent render() calls in this file.
  afterEach(() => {
    cleanup();
  });

  it("renders the muted 'not polled yet' fallback when percent is null", () => {
    render(<UsageCell percent={null} resetsAt={null} />);

    // The fallback text is the single source of truth for the "unknown" state.
    const fallback = screen.getByText("not polled yet");
    expect(fallback).toBeInTheDocument();

    // The percent display must NOT appear (no rounded %, no resets text).
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/resets in/)).not.toBeInTheDocument();
  });

  it("renders the rounded percent when usagePercent is a number", () => {
    render(<UsageCell percent={42.4} resetsAt={null} />);

    // Math.round(42.4) === 42 — verify the rendered text, not the internal var.
    expect(screen.getByText("42%")).toBeInTheDocument();
    // Fallback text must be absent when we have real data.
    expect(screen.queryByText("not polled yet")).not.toBeInTheDocument();
  });

  it("renders percent plus resets-at label when both fields are populated", () => {
    // Construct a resetsAt two hours in the future so the label is stable.
    const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000 + 60_000).toISOString();

    render(<UsageCell percent={75} resetsAt={twoHoursFromNow} />);

    expect(screen.getByText("75%")).toBeInTheDocument();
    // Match either "resets in 2h" or "resets in 2h Nm" (formatResetsAt may
    // emit either shape depending on the exact remainder).
    expect(screen.getByText(/resets in 2h/)).toBeInTheDocument();
  });

  it("renders 0% (not the fallback) when percent is explicitly zero", () => {
    // This is the critical negative case: percent === 0 must NOT be mistaken
    // for "null / unpolled" by the component.
    render(<UsageCell percent={0} resetsAt={null} />);

    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.queryByText("not polled yet")).not.toBeInTheDocument();
  });

  it("rounds fractional percent values to the nearest integer", () => {
    render(<UsageCell percent={89.6} resetsAt={null} />);

    // 89.6 rounds to 90 — this also lands in the "error" (>=90) color band.
    expect(screen.getByText("90%")).toBeInTheDocument();
  });

  it("shows 'resets now' when resetsAt is in the past", () => {
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    render(<UsageCell percent={50} resetsAt={oneMinuteAgo} />);

    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("resets now")).toBeInTheDocument();
  });
});
