import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Sparkline, SparklineSkeleton } from "../Sparkline";

describe("Sparkline", () => {
  it("renders SVG with valid data", () => {
    const { container } = render(<Sparkline data={[10, 20, 15, 30, 25]} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("renders path element", () => {
    const { container } = render(<Sparkline data={[5, 10, 15]} />);
    const path = container.querySelector("path");
    expect(path).toBeInTheDocument();
    expect(path?.getAttribute("d")).toContain("M");
  });

  it("returns null for fewer than 2 data points", () => {
    const { container } = render(<Sparkline data={[42]} />);
    expect(container.firstChild).toBeNull();
  });

  it("handles flat data (all same values)", () => {
    const { container } = render(<Sparkline data={[5, 5, 5, 5]} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

describe("SparklineSkeleton", () => {
  it("renders without crashing", () => {
    const { container } = render(<SparklineSkeleton />);
    expect(container.firstChild).toBeInTheDocument();
  });
});
