import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatusDot } from "../StatusDot";

describe("StatusDot", () => {
  it("renders active status", () => {
    const { container } = render(<StatusDot status="active" />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it("renders idle status", () => {
    const { container } = render(<StatusDot status="idle" />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it("renders ended status", () => {
    const { container } = render(<StatusDot status="ended" />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it("has role=status for accessibility", () => {
    const { container } = render(<StatusDot status="active" />);
    expect(container.querySelector("[role='status']")).toBeInTheDocument();
  });
});
