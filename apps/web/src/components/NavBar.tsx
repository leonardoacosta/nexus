import Link from "next/link";

import { theme } from "./theme";

/**
 * Primary dashboard navigation (elevenlabs task 3.6). The web app previously had
 * no top-level nav — pages were reached only by direct URL or session-row links.
 * This bar is the "primary navigation" the elevenlabs spec asks the Integrations
 * entry to live under. Server component: plain `next/link`s, no active-state
 * (kept dependency-free — no `usePathname`/client boundary needed for chrome).
 */
const LINKS: { href: string; label: string }[] = [
  { href: "/", label: "Sessions" },
  { href: "/radar", label: "Radar" },
  { href: "/integrations/elevenlabs", label: "Integrations" },
];

export function NavBar() {
  return (
    <nav
      style={{
        display: "flex",
        gap: 18,
        alignItems: "center",
        padding: "10px 1.5rem",
        borderBottom: `1px solid ${theme.border}`,
        background: theme.surface,
        fontFamily: theme.mono,
      }}
    >
      <span style={{ fontSize: 13, color: theme.fg, fontWeight: 600 }}>Nexus</span>
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          style={{ fontSize: 13, color: theme.muted, textDecoration: "none" }}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
