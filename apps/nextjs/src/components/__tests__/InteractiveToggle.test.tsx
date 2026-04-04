import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { InteractiveToggle } from "../InteractiveToggle";

afterEach(() => {
  cleanup();
});

describe("InteractiveToggle", () => {
  it("shows 'Streaming (read-only)' in stream mode", () => {
    render(
      <InteractiveToggle mode="stream" onModeChange={vi.fn()} connected={true} />,
    );

    expect(screen.getByTestId("mode-indicator")).toHaveTextContent(
      "Streaming (read-only)",
    );
  });

  it("shows 'Interactive' in interact mode", () => {
    render(
      <InteractiveToggle mode="interact" onModeChange={vi.fn()} connected={true} />,
    );

    expect(screen.getByTestId("mode-indicator")).toHaveTextContent("Interactive");
  });

  it("calls onModeChange with 'interact' when clicking toggle from stream mode", () => {
    const onModeChange = vi.fn();
    render(
      <InteractiveToggle mode="stream" onModeChange={onModeChange} connected={true} />,
    );

    fireEvent.click(screen.getByTestId("mode-toggle-btn"));
    expect(onModeChange).toHaveBeenCalledWith("interact");
  });

  it("calls onModeChange with 'stream' when clicking toggle from interact mode", () => {
    const onModeChange = vi.fn();
    render(
      <InteractiveToggle mode="interact" onModeChange={onModeChange} connected={true} />,
    );

    fireEvent.click(screen.getByTestId("mode-toggle-btn"));
    expect(onModeChange).toHaveBeenCalledWith("stream");
  });

  it("shows disconnect button only in interactive mode", () => {
    const { rerender } = render(
      <InteractiveToggle mode="stream" onModeChange={vi.fn()} connected={true} />,
    );

    expect(screen.queryByTestId("disconnect-btn")).not.toBeInTheDocument();

    rerender(
      <InteractiveToggle mode="interact" onModeChange={vi.fn()} connected={true} />,
    );

    expect(screen.getByTestId("disconnect-btn")).toBeInTheDocument();
  });

  it("disconnect button reverts to stream mode", () => {
    const onModeChange = vi.fn();
    render(
      <InteractiveToggle mode="interact" onModeChange={onModeChange} connected={true} />,
    );

    fireEvent.click(screen.getByTestId("disconnect-btn"));
    expect(onModeChange).toHaveBeenCalledWith("stream");
  });

  it("toggle button shows correct label per mode", () => {
    const { rerender } = render(
      <InteractiveToggle mode="stream" onModeChange={vi.fn()} connected={true} />,
    );

    expect(screen.getByTestId("mode-toggle-btn")).toHaveTextContent(
      "Switch to Interactive",
    );

    rerender(
      <InteractiveToggle mode="interact" onModeChange={vi.fn()} connected={true} />,
    );

    expect(screen.getByTestId("mode-toggle-btn")).toHaveTextContent(
      "Switch to Stream",
    );
  });
});
