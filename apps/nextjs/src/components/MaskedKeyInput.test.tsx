/**
 * Regression test for `MaskedKeyInput`.
 *
 * The form's security contract: the bullet placeholder is decorative; the
 * `<input>.value` MUST remain the empty string until the user types. A
 * future refactor that accidentally binds the placeholder string to `value`
 * would silently leak a fake "stored key" into form submissions and break
 * the partial-update semantics (PATCH would echo "••••••" back to the
 * agent, which would encrypt and store *that* string).
 *
 * Spec: harden-elevenlabs-credential-p2-p3-gcf §
 * "MaskedKeyInput placeholder MUST never bind to value"
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { MaskedKeyInput } from "./MaskedKeyInput";

afterEach(() => {
  cleanup();
});

// Same bullet pattern declared in MaskedKeyInput.tsx. If the component
// changes the pattern, this test should fail loudly so we re-evaluate the
// security contract rather than silently drift.
const BULLET_PLACEHOLDER = "••••••••••••";

describe("MaskedKeyInput", () => {
  it("renders an empty value even when hasKey=true", () => {
    render(<MaskedKeyInput hasKey={true} onChange={() => {}} />);

    const input = screen.getByTestId(
      "elevenlabs-api-key-input",
    ) as HTMLInputElement;

    // The decorative bullets MUST live in `placeholder`, never in `value`.
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(BULLET_PLACEHOLDER);
    expect(input.value).not.toBe(BULLET_PLACEHOLDER);
  });

  it("renders an empty value when hasKey=false (custom placeholder)", () => {
    render(
      <MaskedKeyInput
        hasKey={false}
        onChange={() => {}}
        placeholder="Paste it here"
      />,
    );

    const input = screen.getByTestId(
      "elevenlabs-api-key-input",
    ) as HTMLInputElement;

    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Paste it here");
  });

  it("calls onChange with the typed character, not the bullet placeholder", () => {
    const onChange = vi.fn();

    render(<MaskedKeyInput hasKey={true} onChange={onChange} />);

    const input = screen.getByTestId(
      "elevenlabs-api-key-input",
    ) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "x" } });

    // The handler fires with the typed value — never with a bullet string.
    // (If the value were ever bound to the placeholder, the change event
    // would surface "••••••••••••x" instead of "x".)
    expect(onChange).toHaveBeenCalledWith("x");
    expect(onChange).not.toHaveBeenCalledWith(
      expect.stringContaining(BULLET_PLACEHOLDER),
    );
    expect(input.value).toBe("x");
  });
});
