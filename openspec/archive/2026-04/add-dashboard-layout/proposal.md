# Add Dashboard Layout

## Why
The Nexus web dashboard needs an app shell before any pages can be built. Without a layout, nav, and design token system, every subsequent page spec would have to define its own chrome and theming, leading to inconsistency and duplicated work.

## What Changes
Create a Next.js App Router shell with a sidebar nav (Dashboard/Health/Projects/Settings), dark theme via CSS custom properties imported from brand tokens, Geist Sans + Geist Mono fonts, Phosphor Icons, keyboard navigation hooks (j/k, /, Escape), and a set of reusable base components (Card, Badge, StatusDot, Gauge, Sparkline). The layout targets 1440px+ desktop as the primary viewport.
