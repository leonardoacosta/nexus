# Add Command Palette

## Why
Power users managing dozens of sessions across machines need a fast way to find and navigate to specific sessions without scrolling through grouped lists. A keyboard-first command palette is the standard UX pattern for this and aligns with the developer audience's expectations.

## What Changes
Build a "/" triggered command palette overlay that fuzzy-matches across session project names, machine hostnames, and status values. Supports full keyboard navigation with arrow keys, Enter to select, and Escape to dismiss. Selecting a result navigates to the corresponding session or filtered view.
