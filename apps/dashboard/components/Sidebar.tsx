"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  House,
  Heartbeat,
  FolderSimple,
  Gear,
} from "@phosphor-icons/react";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: House },
  { href: "/health", label: "Health", icon: Heartbeat },
  { href: "/projects", label: "Projects", icon: FolderSimple },
  { href: "/settings", label: "Settings", icon: Gear },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">Nexus</div>
      <nav className="sidebar-nav">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const isActive =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
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
        })}
      </nav>
    </aside>
  );
}
