import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

// Mock next/link
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import { Sidebar } from "../Sidebar";

afterEach(() => {
  cleanup();
});

describe("Sidebar", () => {
  it("renders the brand name", () => {
    render(<Sidebar />);
    expect(screen.getByText("Nexus")).toBeInTheDocument();
  });

  it("renders all four nav links", () => {
    render(<Sidebar />);
    expect(screen.getAllByRole("link")).toHaveLength(4);
  });

  it("marks Dashboard as active on root path", () => {
    render(<Sidebar />);
    const links = screen.getAllByRole("link");
    const dashboardLink = links.find((el) => el.textContent?.includes("Dashboard"));
    expect(dashboardLink?.className).toBe("active");
  });

  it("does not mark other links as active on root path", () => {
    render(<Sidebar />);
    const links = screen.getAllByRole("link");
    const nonDashboard = links.filter(
      (el) => !el.textContent?.includes("Dashboard"),
    );
    nonDashboard.forEach((link) => {
      expect(link.className).not.toBe("active");
    });
  });
});
