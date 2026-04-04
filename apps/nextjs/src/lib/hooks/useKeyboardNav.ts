"use client";

import { useEffect, useCallback } from "react";

interface UseKeyboardNavOptions {
  /** Total number of items in the list */
  itemCount: number;
  /** Called when the active index changes */
  onIndexChange: (index: number) => void;
  /** Called when "/" is pressed (command palette trigger) */
  onCommandPalette?: () => void;
  /** Called when Escape is pressed (dismiss overlays) */
  onEscape?: () => void;
  /** Called when Enter is pressed on the active item */
  onSelect?: (index: number) => void;
  /** Whether the hook is active (default: true) */
  enabled?: boolean;
}

/**
 * Keyboard navigation hook for list-based views.
 *
 * - j / ArrowDown: move down
 * - k / ArrowUp: move up
 * - /: trigger command palette
 * - Escape: dismiss overlays
 * - Enter: select active item
 */
export function useKeyboardNav({
  itemCount,
  onIndexChange,
  onCommandPalette,
  onEscape,
  onSelect,
  enabled = true,
}: UseKeyboardNavOptions) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled || itemCount === 0) return;

      // Skip when user is typing in an input/textarea
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        // Still handle Escape in inputs
        if (e.key === "Escape" && onEscape) {
          onEscape();
          e.preventDefault();
        }
        return;
      }

      switch (e.key) {
        case "j":
        case "ArrowDown":
          onIndexChange(1);
          e.preventDefault();
          break;
        case "k":
        case "ArrowUp":
          onIndexChange(-1);
          e.preventDefault();
          break;
        case "/":
          if (onCommandPalette) {
            onCommandPalette();
            e.preventDefault();
          }
          break;
        case "Escape":
          if (onEscape) {
            onEscape();
            e.preventDefault();
          }
          break;
        case "Enter":
          if (onSelect) {
            // onSelect receives the current index — caller manages it
            // We pass 0 as a signal; caller should use their own tracked index
            onSelect(0);
            e.preventDefault();
          }
          break;
      }
    },
    [enabled, itemCount, onIndexChange, onCommandPalette, onEscape, onSelect],
  );

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, handleKeyDown]);
}
