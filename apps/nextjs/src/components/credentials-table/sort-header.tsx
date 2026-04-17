"use client";

import type { SortColumn, SortState } from "./types";

export function SortHeader({
  label,
  column,
  current,
  onSort,
  align,
}: {
  label: string;
  column: SortColumn;
  current: SortState;
  onSort: (column: SortColumn) => void;
  align?: "left" | "right";
}) {
  const isActive = current.column === column;
  const indicator = isActive
    ? current.direction === "asc"
      ? "\u25B2"
      : "\u25BC"
    : "\u21C5";

  return (
    <th
      onClick={() => onSort(column)}
      style={{
        padding: "var(--space-2) var(--space-3)",
        textAlign: align ?? "left",
        fontSize: "var(--font-size-xs)",
        fontWeight: "var(--font-weight-medium)",
        color: isActive ? "var(--color-fg)" : "var(--color-fg-muted)",
        textTransform: "uppercase",
        letterSpacing: "var(--tracking-wide)",
        whiteSpace: "nowrap",
        cursor: "pointer",
        userSelect: "none",
        transition: "color var(--transition-fast)",
      }}
    >
      {label}
      <span
        style={{
          marginLeft: 4,
          opacity: isActive ? 1 : 0.3,
          fontSize: "0.75em",
          fontFamily: "var(--font-mono)",
        }}
      >
        {indicator}
      </span>
    </th>
  );
}
