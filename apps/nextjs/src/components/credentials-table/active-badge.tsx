"use client";

/**
 * ActiveBadge
 *
 * Rendered inline next to the account name when the account is the one
 * currently being read by Claude Code on the agent host (derived from the
 * `/credentials/active` fingerprint watcher).
 *
 * Hover tooltip exposes the resolved on-disk path so operators can confirm
 * which file the symlink currently points at.
 */

export function ActiveBadge({ resolvedPath }: { resolvedPath: string | null }) {
  const title = resolvedPath
    ? `Active for Claude Code — reading ${resolvedPath}`
    : "Active for Claude Code";

  return (
    <span
      title={title}
      aria-label={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        marginLeft: "var(--space-2)",
        padding: "1px 6px",
        fontSize: "10px",
        fontWeight: "var(--font-weight-semibold)",
        textTransform: "uppercase",
        letterSpacing: "var(--tracking-wide)",
        color: "var(--color-success)",
        background: "var(--color-success-ghost)",
        borderRadius: "var(--radius-sm)",
        lineHeight: 1.2,
        cursor: "help",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          background: "var(--color-success)",
          boxShadow: "0 0 6px var(--color-success)",
        }}
      />
      active
    </span>
  );
}
