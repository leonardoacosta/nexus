# Brand Identity: Nexus

## Name & Tagline

- **Product name**: Nexus
- **Tagline**: See every session. Control any machine.
- **Elevator pitch**: A real-time web dashboard that aggregates and controls all your AI coding
  sessions across every machine on your network.

## Voice & Tone

- **Personality**: Direct, precise, utilitarian, confident, fast
  - *Direct* — no hedging, no filler. "3 sessions active" not "You currently have 3 sessions."
  - *Precise* — numbers over adjectives. Timestamps over "recently."
  - *Utilitarian* — every word earns its place. UI text is a tool, not decoration.
  - *Confident* — states facts, doesn't apologize. "Session ended" not "Sorry, this session
    has ended."
  - *Fast* — brevity is velocity. Shorter labels, tighter copy, faster comprehension.
- **Tone register**: Technical-casual. Like talking to a sharp colleague — no formality, no
  fluff, but not sloppy.
- **Writing style**: Active voice, short sentences (8-12 words), technical vocabulary assumed
  (no dumbing down for developers).
- **Anti-patterns**: This brand would NEVER sound like:
  - Marketing copy ("Supercharge your workflow!")
  - Enterprise software ("Please contact your administrator")
  - Consumer apps ("Yay! You did it!")
  - Apologetic UX ("Oops, something went wrong")

## Color Palette

Dark-first palette. Near-black backgrounds with high-contrast foreground text. Status colors
carry semantic weight — they are the primary information channel, not decoration.

| Role | Hex | Usage |
|------|-----|-------|
| Background | `#0A0A0B` | App background, deepest layer |
| Surface | `#111113` | Cards, panels, elevated containers |
| Surface Raised | `#1A1A1D` | Hover states, active panels, dropdowns |
| Border | `#27272A` | Panel dividers, card borders, separators |
| Border Bright | `#3F3F46` | Focused inputs, active borders |
| Muted | `#71717A` | Secondary text, timestamps, metadata |
| Foreground | `#FAFAFA` | Primary text, headings |
| Foreground Dim | `#A1A1AA` | Body text, descriptions |
| Primary | `#3B82F6` | Active sessions, primary actions, links |
| Primary Hover | `#2563EB` | Hovered primary elements |
| Success | `#22C55E` | Healthy status, connected, running |
| Warning | `#EAB308` | Degraded, slow, needs attention |
| Error | `#EF4444` | Failed, disconnected, critical |
| Info | `#3B82F6` | Informational badges, neutral status |

### Rationale

- **Near-black, not pure black**: `#0A0A0B` reduces eye strain on OLED and LCD panels compared
  to `#000000`. Provides enough depth for surface elevation layers.
- **Zinc-based neutrals**: The neutral scale uses zinc undertones (blue-gray) rather than warm
  gray, matching the technical/cold aesthetic of terminal emulators and dev tools.
- **Blue as primary**: Blue signals "active" and "interactive" without competing with status
  semantics. Avoids the green/red/yellow spectrum reserved for health indicators.
- **Status colors are saturated**: These must pop against dark backgrounds. No pastel variants —
  status must be readable at a glance in dense data layouts.

## Typography System

- **Display font**: Geist Sans — headings, labels, navigation items. Clean geometric sans-serif
  from Vercel. Chosen for its modern developer aesthetic and excellent legibility at small sizes.
- **Body font**: Geist Sans — descriptions, body text, UI copy. Single font family reduces
  cognitive load and visual noise.
- **Mono font**: Geist Mono — session data, timestamps, machine names, code, terminal output,
  any data that benefits from tabular alignment. Developer-native monospace that pairs with
  Geist Sans by design.
- **Scale** (modular, ratio 1.25):
  - Display: 2.25rem (36px) — page titles, hero numbers
  - H1: 1.875rem (30px) — section headers
  - H2: 1.5rem (24px) — panel titles
  - H3: 1.25rem (20px) — card headers
  - H4: 1.125rem (18px) — sub-sections
  - Body: 1rem (16px) — default text
  - Small: 0.875rem (14px) — metadata, timestamps
  - XS: 0.75rem (12px) — badges, micro-labels

### Rationale

- **Single sans-serif family**: Nexus is a dashboard, not a magazine. One family for all
  non-data text keeps the interface fast to scan.
- **Geist over Inter**: Geist is purpose-built for developer tools by Vercel. Its metrics are
  optimized for UI labels and data-adjacent text. Inter is more editorial.
- **Geist Mono over JetBrains Mono**: Both are excellent. Geist Mono was chosen for visual
  consistency with Geist Sans — they share design DNA.

## Design Principles

1. **Density over whitespace** — Pack information tight. Developers read data tables and
   terminal output all day. They don't need generous padding between session cards. Every
   pixel should show useful information or get out of the way.

2. **Status at a glance** — The most important information (is this session alive? is this
   machine healthy?) must be visible without interaction. Color-coded dots, inline badges,
   and sparklines — not hidden behind hover tooltips or detail pages.

3. **Keyboard-first, mouse-welcome** — Every action reachable by keyboard. Mouse interactions
   are supported but never required. Navigation follows vim-like conventions where natural
   (j/k for lists, / for search).

4. **No ceremony** — Zero onboarding flows, no welcome modals, no empty states with
   illustrations. The dashboard loads and shows data immediately. If there's nothing to show,
   say "No active sessions" in plain text.

5. **Terminal heritage** — The visual language borrows from terminal emulators: monospace data,
   dark backgrounds, high contrast, status indicators, and compact layouts. This is a tool
   for people who live in terminals.
