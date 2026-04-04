/**
 * AC-12: 92% disk — warning color gauge.
 *
 * Verifies that the Gauge component renders with warning color
 * when value exceeds 80%.
 */

import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { Gauge } from "@/components/ui";

afterEach(() => {
  cleanup();
});

describe("AC-12: Warning color gauge at high utilization", () => {
  it("shows warning color for 92% disk usage", () => {
    const { container } = render(<Gauge value={92} label="Disk" />);

    // The label should be present
    expect(screen.getByText("Disk")).toBeInTheDocument();
    expect(screen.getByText("92%")).toBeInTheDocument();

    // The fill bar should use warning color (>= 80 and <= 95)
    const fillBar = container.querySelector("[style*='width: 92%']") as HTMLElement;
    expect(fillBar).not.toBeNull();
    expect(fillBar.style.background).toBe("var(--color-warning)");
  });

  it("shows error color for 97% usage", () => {
    const { container } = render(<Gauge value={97} label="Disk" />);

    expect(screen.getByText("97%")).toBeInTheDocument();

    const fillBar = container.querySelector("[style*='width: 97%']") as HTMLElement;
    expect(fillBar).not.toBeNull();
    expect(fillBar.style.background).toBe("var(--color-error)");
  });

  it("shows success color for 45% usage", () => {
    const { container } = render(<Gauge value={45} label="CPU" />);

    expect(screen.getByText("45%")).toBeInTheDocument();

    const fillBar = container.querySelector("[style*='width: 45%']") as HTMLElement;
    expect(fillBar).not.toBeNull();
    expect(fillBar.style.background).toBe("var(--color-success)");
  });

  it("shows warning color at exactly 80%", () => {
    const { container } = render(<Gauge value={80} label="RAM" />);

    expect(screen.getByText("80%")).toBeInTheDocument();

    const fillBar = container.querySelector("[style*='width: 80%']") as HTMLElement;
    expect(fillBar).not.toBeNull();
    expect(fillBar.style.background).toBe("var(--color-warning)");
  });

  it("clamps value at 100%", () => {
    render(<Gauge value={150} label="CPU" />);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("clamps value at 0%", () => {
    render(<Gauge value={-10} label="CPU" />);
    expect(screen.getByText("0%")).toBeInTheDocument();
  });
});
