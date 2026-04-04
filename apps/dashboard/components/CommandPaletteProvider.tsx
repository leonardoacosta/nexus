"use client";

import { useState, useEffect, useCallback } from "react";
import { CommandPalette } from "./CommandPalette";

/**
 * Global command palette provider.
 * Listens for "/" keypress (when not in an input) to open the palette.
 * Place in the root layout so it's available on all pages.
 */
export function CommandPaletteProvider() {
  const [isOpen, setIsOpen] = useState(false);

  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't fire when user is already typing in an input field
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      if (e.key === "/") {
        e.preventDefault();
        setIsOpen(true);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return <CommandPalette isOpen={isOpen} onClose={close} />;
}
