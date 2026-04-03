# Icon Style Guide

## Style

- **Type**: Line (stroke-only, no fills)
- **Corner radius**: Slightly rounded (2px radius on corners)
- **Stroke weight**: 1.5px (balances visibility on dark backgrounds with density)
- **Size grid**: 16px (inline/badges) | 20px (default/nav) | 24px (emphasis) | 32px (hero)
- **Optical alignment**: Icons are optically centered within their bounding box, not
  mathematically centered. Play icons shift right, arrows get extra end-cap space.

## Library

**Phosphor Icons** (phosphoricons.com) — line weight variant.

Phosphor was chosen over Lucide/Heroicons for:
- Consistent 1.5px stroke weight across all icons (Lucide varies)
- Larger icon set (6,000+ vs ~1,200) for niche needs (terminal, network, signal)
- Six weight variants (thin/light/regular/bold/fill/duotone) for future flexibility
- MIT license, actively maintained

## Personality Fit

Line icons match the "minimal chrome" principle — they convey meaning without visual weight.
On dark backgrounds, thin strokes create a refined, technical aesthetic that complements
monospace data. The consistent stroke weight prevents visual hierarchy conflicts with text.

## Key Icons (Nexus Domain)

| Concept | Icon Name | Usage |
|---------|-----------|-------|
| Session (active) | `Terminal` | Active Claude Code session |
| Session (idle) | `TerminalWindow` | Idle/paused session |
| Machine/Agent | `Desktop` | Machine in agent list |
| Health | `Heartbeat` | System health indicator |
| CPU | `Cpu` | Processor metrics |
| Memory | `Memory` | RAM usage |
| Disk | `HardDrive` | Storage metrics |
| Network | `WifiHigh` | Tailscale connectivity |
| Project | `FolderOpen` | Project grouping |
| Streaming | `Eye` | Read-only session stream |
| Interactive | `PencilLine` | Full interactive control |
| Connected | `PlugsConnected` | Agent connected |
| Disconnected | `Plugs` | Agent disconnected |
| Settings | `GearSix` | Configuration |
| Search | `MagnifyingGlass` | Search/filter |
| Notification | `Bell` | Alerts and notifications |

## Size Reference

```
16px  — Inline status dots, badge icons, table row icons
20px  — Navigation items, list item icons, button icons (default)
24px  — Panel header icons, section markers, emphasis
32px  — Empty state icons, hero metrics, large status indicators
```

## Color Rules

- **Default**: `--color-fg-muted` (#71717A) — icons are secondary to text
- **Interactive**: `--color-fg` (#FAFAFA) on hover/focus
- **Active nav**: `--color-primary` (#3B82F6)
- **Status**: Use semantic colors (`--color-success`, `--color-warning`, `--color-error`)
- **Never**: Raw color values. Always use token variables.
