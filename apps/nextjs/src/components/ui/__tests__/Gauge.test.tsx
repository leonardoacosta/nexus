import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Gauge, GaugeSkeleton } from "../Gauge";

describe("Gauge", () => {
  it("renders with value", () => {
    render(<Gauge value={42} />);
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("clamps value to 0", () => {
    render(<Gauge value={-10} />);
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("clamps value to 100", () => {
    render(<Gauge value={150} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("renders label when provided", () => {
    render(<Gauge value={50} label="CPU" />);
    expect(screen.getByText("CPU")).toBeInTheDocument();
  });
});

describe("GaugeSkeleton", () => {
  it("renders without crashing", () => {
    const { container } = render(<GaugeSkeleton />);
    expect(container.firstChild).toBeInTheDocument();
  });
});
