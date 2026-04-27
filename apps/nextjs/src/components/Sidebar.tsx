"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  House,
  Heartbeat,
  FolderSimple,
  Key,
  Gear,
  FileText,
  Warning,
  Plugs,
  SpeakerHigh,
  Bell,
} from "@phosphor-icons/react";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: House },
  { href: "/health", label: "Health", icon: Heartbeat },
  { href: "/projects", label: "Projects", icon: FolderSimple },
  { href: "/credentials", label: "Credentials", icon: Key },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/specs", label: "Specs", icon: FileText },
  { href: "/failures", label: "Failures", icon: Warning },
  { href: "/settings", label: "Settings", icon: Gear },
] as const;

const INTEGRATIONS_ITEMS = [
  {
    href: "/integrations/elevenlabs",
    label: "ElevenLabs",
    icon: SpeakerHigh,
  },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  const renderLink = (item: {
    href: string;
    label: string;
    icon: typeof House;
  }) => {
    const { href, label, icon: Icon } = item;
    const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
    return (
      <Link
        key={href}
        href={href}
        className={isActive ? "active" : undefined}
      >
        <span className="nav-icon">
          <Icon size={20} weight={isActive ? "fill" : "regular"} />
        </span>
        {label}
      </Link>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">Nexus</div>
      <nav className="sidebar-nav">
        {NAV_ITEMS.map(renderLink)}

        <div
          className="sidebar-nav-group-label"
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-fg-muted)",
            textTransform: "uppercase",
            letterSpacing: "var(--tracking-wide)",
            padding: "var(--space-4) var(--space-3) var(--space-1)",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
          }}
        >
          <Plugs size={14} weight="regular" />
          Integrations
        </div>
        {INTEGRATIONS_ITEMS.map(renderLink)}
      </nav>
    </aside>
  );
}
