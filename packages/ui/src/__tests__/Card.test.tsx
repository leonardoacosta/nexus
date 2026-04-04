import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Card, CardSkeleton } from "../Card";

describe("Card", () => {
  it("renders children", () => {
    render(<Card>Content here</Card>);
    expect(screen.getByText("Content here")).toBeInTheDocument();
  });

  it("renders title when provided", () => {
    render(<Card title="Test Title">Body</Card>);
    expect(screen.getByText("Test Title")).toBeInTheDocument();
  });

  it("omits title when not provided", () => {
    const { container } = render(<Card>Body only</Card>);
    expect(container.querySelectorAll("h3")).toHaveLength(0);
  });
});

describe("CardSkeleton", () => {
  it("renders without crashing", () => {
    const { container } = render(<CardSkeleton />);
    expect(container.firstChild).toBeInTheDocument();
  });
});
