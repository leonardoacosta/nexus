"use client";

/**
 * Mobile soft-keyboard input bridge for the WTerm attach view.
 *
 * WTerm 0.3.0 already mounts a hidden `<textarea>` and listens for `keydown` +
 * `input` + `compositionend` (see `@wterm/dom/dist/input.js`). On a DESKTOP
 * keyboard that covers everything. On a PHONE soft keyboard two things break:
 *
 *  1. **The keyboard never appears.** WTerm's textarea is positioned at
 *     `left:-9999px` with `pointer-events:none`. WTerm focuses it on a `.wterm`
 *     CLICK, but on touch the synthetic click can land after the gesture layer
 *     swallows the event, and iOS only raises the keyboard when `focus()` runs
 *     INSIDE a user gesture. We add an explicit `touchend`/`pointerup` focus on
 *     the host so a tap reliably raises the keyboard within the gesture.
 *
 *  2. **Enter / Backspace silently drop.** Many Android keyboards (and iOS in
 *     some apps) emit `keydown` with `key:"Unidentified"` / `keyCode:229` and
 *     deliver the real edit as a `beforeinput` event with an `inputType`
 *     (`insertLineBreak`, `deleteContentBackward`, ...). WTerm's `handleInput`
 *     only forwards `textarea.value` (printable chars) and ignores these edit
 *     intents, so Enter and Backspace never reach the PTY. We add a
 *     `beforeinput` listener that maps the edit intents to the VT control bytes
 *     and sends them straight through `sendInput`, calling `preventDefault()`
 *     so WTerm's own `input` handler doesn't ALSO emit a stray newline char.
 *
 * The bridge is renderer-aware (it reaches into the textarea WTerm built) but
 * stays in the app layer — `~/lib` is untouched and never imports `@wterm/*`.
 */

/** Map a `beforeinput` edit intent to the VT byte sequence the PTY expects. */
function inputTypeToBytes(inputType: string, _data: string | null): string | null {
  switch (inputType) {
    case "insertLineBreak":
    case "insertParagraph":
      return "\r"; // Enter
    case "deleteContentBackward":
      return "\x7f"; // Backspace (DEL)
    case "deleteContentForward":
      return "\x1b[3~"; // Delete
    case "insertText":
    case "insertCompositionText":
    case "insertFromComposition":
    case "insertReplacementText":
    case "insertFromPaste":
      // Printable text: WTerm's own `input` handler forwards textarea.value, so
      // we let it through (return null = don't intercept). Returning the data
      // here AND letting WTerm fire would double-type.
      return null;
    default:
      return null;
  }
}

export interface MobileKeyboardBridge {
  /** Tear down the listeners. Call from the attach effect cleanup. */
  dispose: () => void;
  /** Force the soft keyboard up (used by an explicit "keyboard" button). */
  focusInput: () => void;
}

/**
 * Wire the bridge onto a mounted WTerm host. Returns null if the textarea WTerm
 * builds is not found (defensive — should always exist after `wterm.init()`).
 *
 * @param host  the `.wterm` element WTerm mounted into
 * @param send  send raw input bytes to the PTY (gated read-only upstream)
 */
export function attachMobileKeyboardBridge(
  host: HTMLElement,
  send: (data: string) => void,
): MobileKeyboardBridge | null {
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) return null;

  // (2) Bridge edit intents (Enter/Backspace/Delete) that soft keyboards send
  // as `beforeinput` rather than `keydown`.
  const onBeforeInput = (e: Event) => {
    const ie = e as InputEvent;
    const bytes = inputTypeToBytes(ie.inputType, ie.data);
    if (bytes !== null) {
      e.preventDefault(); // stop WTerm's `input` handler from emitting a newline
      send(bytes);
    }
  };
  textarea.addEventListener("beforeinput", onBeforeInput);

  // (1) A tap anywhere on the terminal raises the soft keyboard. `touchend`
  // fires inside the user gesture (iOS requirement) and after the gesture layer
  // has decided this was a tap (not a pinch/pan). We also keep a `pointerup`
  // fallback for hybrid/stylus devices that don't emit touch events.
  const focusFromGesture = () => textarea.focus({ preventScroll: true });
  host.addEventListener("touchend", focusFromGesture, { passive: true });
  host.addEventListener("pointerup", focusFromGesture);

  return {
    focusInput: () => textarea.focus({ preventScroll: true }),
    dispose: () => {
      textarea.removeEventListener("beforeinput", onBeforeInput);
      host.removeEventListener("touchend", focusFromGesture);
      host.removeEventListener("pointerup", focusFromGesture);
    },
  };
}
