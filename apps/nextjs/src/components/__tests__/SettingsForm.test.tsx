import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SettingsForm } from "../SettingsForm";

// ---------------------------------------------------------------------------
// Mock localStorage
// ---------------------------------------------------------------------------

const mockStorage = new Map<string, string>();

beforeEach(() => {
  mockStorage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mockStorage.get(key) ?? null,
    setItem: (key: string, value: string) => mockStorage.set(key, value),
    removeItem: (key: string) => mockStorage.delete(key),
    clear: () => mockStorage.clear(),
    length: 0,
    key: () => null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SettingsForm", () => {
  it("renders notification preference checkboxes", () => {
    render(<SettingsForm />);
    expect(screen.getByTestId("sound-enabled")).toBeInTheDocument();
    expect(screen.getByTestId("desktop-notifications")).toBeInTheDocument();
    expect(screen.getByTestId("channel-sessions")).toBeInTheDocument();
    expect(screen.getByTestId("channel-health")).toBeInTheDocument();
    expect(screen.getByTestId("channel-errors")).toBeInTheDocument();
  });

  it("renders polling interval selector", () => {
    render(<SettingsForm />);
    const select = screen.getByTestId("polling-interval");
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue("5000"); // default 5 seconds
  });

  it("renders keyboard shortcuts table", () => {
    render(<SettingsForm />);
    const table = screen.getByTestId("shortcuts-table");
    expect(table).toBeInTheDocument();
    expect(screen.getByText("Open Command Palette")).toBeInTheDocument();
    expect(screen.getByText("Close Command Palette")).toBeInTheDocument();
    expect(screen.getByText("Navigate Results")).toBeInTheDocument();
    expect(screen.getByText("Select Session")).toBeInTheDocument();
  });

  it("renders save button", () => {
    render(<SettingsForm />);
    expect(screen.getByTestId("save-settings")).toBeInTheDocument();
  });

  it("toggles sound notifications checkbox", () => {
    render(<SettingsForm />);
    const checkbox = screen.getByTestId("sound-enabled") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it("toggles channel checkboxes", () => {
    render(<SettingsForm />);

    const sessions = screen.getByTestId("channel-sessions") as HTMLInputElement;
    expect(sessions.checked).toBe(true);
    fireEvent.click(sessions);
    expect(sessions.checked).toBe(false);
  });

  it("changes polling interval", () => {
    render(<SettingsForm />);
    const select = screen.getByTestId("polling-interval") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "10000" } });
    expect(select.value).toBe("10000");
  });

  it("saves settings to localStorage and shows confirmation", () => {
    vi.useFakeTimers();
    render(<SettingsForm />);

    // Change a setting first
    const checkbox = screen.getByTestId("sound-enabled") as HTMLInputElement;
    fireEvent.click(checkbox);

    // Click save
    fireEvent.click(screen.getByTestId("save-settings"));

    // Confirmation should appear
    expect(screen.getByTestId("save-confirmation")).toBeInTheDocument();
    expect(screen.getByText("Settings saved")).toBeInTheDocument();

    // Verify localStorage was written
    const stored = mockStorage.get("nexus-notification-prefs");
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed.soundEnabled).toBe(false);

    vi.useRealTimers();
  });

  it("loads saved settings from localStorage", () => {
    mockStorage.set(
      "nexus-notification-prefs",
      JSON.stringify({
        soundEnabled: false,
        desktopNotifications: false,
        channels: { sessions: false, health: true, errors: true },
        perProjectRules: [],
      }),
    );
    mockStorage.set(
      "nexus-general-settings",
      JSON.stringify({ pollingIntervalMs: 10000 }),
    );

    render(<SettingsForm />);

    expect(
      (screen.getByTestId("sound-enabled") as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByTestId("desktop-notifications") as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByTestId("channel-sessions") as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByTestId("polling-interval") as HTMLSelectElement).value,
    ).toBe("10000");
  });

  it("adds and removes per-project rules", () => {
    render(<SettingsForm />);

    // Add a project rule
    const input = screen.getByTestId("project-rule-input");
    fireEvent.change(input, { target: { value: "nexus" } });
    fireEvent.click(screen.getByTestId("add-project-rule"));

    expect(screen.getByText("nexus")).toBeInTheDocument();
    expect(screen.getAllByTestId("project-rule").length).toBe(1);

    // Remove the rule
    fireEvent.click(screen.getByTestId("remove-rule-nexus"));
    expect(screen.queryAllByTestId("project-rule").length).toBe(0);
  });

  it("does not add duplicate project rules", () => {
    render(<SettingsForm />);

    const input = screen.getByTestId("project-rule-input");
    fireEvent.change(input, { target: { value: "nexus" } });
    fireEvent.click(screen.getByTestId("add-project-rule"));

    fireEvent.change(input, { target: { value: "nexus" } });
    fireEvent.click(screen.getByTestId("add-project-rule"));

    expect(screen.getAllByTestId("project-rule").length).toBe(1);
  });
});
