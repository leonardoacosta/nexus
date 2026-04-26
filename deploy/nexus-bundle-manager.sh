#!/usr/bin/env bash
# nexus-bundle-manager.sh — per-project .app bundle factory.
#
# Builds a minimal macOS app bundle for each Nexus project so terminal-notifier
# (or any other UNUserNotificationCenter-backed tool) can pass `-sender
# <bundle-id>` and have macOS render the project's emoji as the LEFT app-icon
# of the notification banner.
#
# Why bundles: macOS Catalina+ locked down runtime icon overrides via
# UNUserNotificationCenter — `-appIcon` is silently ignored. The only
# supported path is for the sender to be a registered .app bundle whose
# CFBundleIconFile is the desired icon.
#
# Bundle layout per project (lazy-created on first use):
#   ~/Applications/Nexus-<code>.app/
#     Contents/
#       Info.plist                 — bundle ID = dev.priceless.nexus.<code>
#       MacOS/nexus-stub           — exit-0 shell script (Gatekeeper requirement)
#       Resources/AppIcon.icns     — emoji rendered + iconutil-converted
#
# Usage:
#   nexus-bundle-manager.sh ensure <code> <emoji> <name>
#     → creates the bundle if missing, echos the bundle ID, exit 0 on success
#   nexus-bundle-manager.sh prime
#     → reads ~/.config/nexus/projects.json (mirrored from Linux) and
#       creates every bundle eagerly (one-time setup to batch the
#       notification permission grants)
#
# Cache locations:
#   ~/Library/Application Support/nexus/icons/   — base PNGs keyed by emoji hash

set -u

BUNDLE_DIR="$HOME/Applications"
BUNDLE_ID_PREFIX="dev.priceless.nexus"
ICON_CACHE_DIR="$HOME/Library/Application Support/nexus/icons"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
LOG_FILE="${NEXUS_BUNDLE_LOG:-$HOME/Library/Logs/nexus-bundle-manager.log}"

_log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE"; }

# Render an emoji to a 1024×1024 transparent PNG using Apple Color Emoji.
_render_emoji_png() {
  local emoji="$1" out="$2"
  /usr/bin/swift - "$emoji" "$out" 2>>"$LOG_FILE" <<'SWIFT'
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count == 3 else { exit(1) }
let emoji = args[1]
let outPath = args[2]
let size: CGFloat = 1024

let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
NSColor.clear.set()
NSRect(x: 0, y: 0, width: size, height: size).fill()

let style = NSMutableParagraphStyle()
style.alignment = .center

let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: size * 0.85),
    .paragraphStyle: style,
]
let str = NSAttributedString(string: emoji, attributes: attrs)
let strSize = str.size()
let y = (size - strSize.height) / 2.0
str.draw(in: NSRect(x: 0, y: y, width: size, height: strSize.height))

img.unlockFocus()

guard let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    exit(1)
}
do {
    try png.write(to: URL(fileURLWithPath: outPath))
} catch {
    exit(1)
}
SWIFT
}

# Cache the base PNG so repeated calls (or shared with the notifier) skip
# the ~3s Swift cold-start.
_ensure_base_png() {
  local emoji="$1"
  /bin/mkdir -p "$ICON_CACHE_DIR"
  local key
  key=$(printf '%s' "$emoji" | /usr/bin/shasum -a 256 | /usr/bin/head -c 16)
  local out="$ICON_CACHE_DIR/$key.png"
  if [ ! -f "$out" ]; then
    _render_emoji_png "$emoji" "$out" || return 1
    [ -f "$out" ] || return 1
  fi
  printf '%s' "$out"
}

# Generate AppIcon.icns from a 1024×1024 base PNG using sips + iconutil.
# Fills out the standard iconset sizes (16/32/64/128/256/512 + @2x variants).
_make_icns() {
  local base_png="$1" icns_out="$2"
  local iconset
  iconset=$(/usr/bin/mktemp -d "/tmp/nexus-iconset.XXXXXX")
  iconset="${iconset}/icon.iconset"
  /bin/mkdir -p "$iconset"

  local size
  for size in 16 32 64 128 256 512; do
    /usr/bin/sips -z "$size" "$size" "$base_png" \
      --out "$iconset/icon_${size}x${size}.png" >/dev/null 2>&1 || return 1
    local twox=$((size * 2))
    /usr/bin/sips -z "$twox" "$twox" "$base_png" \
      --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null 2>&1 || return 1
  done
  /bin/cp "$base_png" "$iconset/icon_1024x1024.png"

  /usr/bin/iconutil -c icns -o "$icns_out" "$iconset" 2>>"$LOG_FILE" || return 1
  /bin/rm -rf "$(/usr/bin/dirname "$iconset")"
}

_write_info_plist() {
  local plist_path="$1" code="$2" name="$3" emoji="$4"
  local bundle_id="${BUNDLE_ID_PREFIX}.${code}"
  /bin/cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${bundle_id}</string>
  <key>CFBundleName</key>
  <string>${name}</string>
  <key>CFBundleDisplayName</key>
  <string>${emoji} ${name}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleSignature</key>
  <string>????</string>
  <key>CFBundleExecutable</key>
  <string>nexus-stub</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
</dict>
</plist>
PLIST
}

_write_stub_executable() {
  local stub_path="$1"
  /bin/cat > "$stub_path" <<'STUB'
#!/bin/bash
# Nexus notification-bundle stub. Never actually run by the user — exists
# only so macOS treats this folder as a valid .app and accepts it as the
# `-sender` of UNUserNotificationCenter banners. Exits cleanly if launched.
exit 0
STUB
  /bin/chmod +x "$stub_path"
}

# ensure_bundle <code> <emoji> <name>
# Creates the bundle if missing. Idempotent. Echoes the bundle ID.
ensure_bundle() {
  local code="$1" emoji="$2" name="$3"
  local bundle_id="${BUNDLE_ID_PREFIX}.${code}"
  local app_dir="$BUNDLE_DIR/Nexus-${code}.app"

  if [ -d "$app_dir" ]; then
    printf '%s' "$bundle_id"
    return 0
  fi

  _log "creating bundle: $app_dir (id=$bundle_id, emoji=$emoji, name=$name)"
  /bin/mkdir -p "$BUNDLE_DIR"
  /bin/mkdir -p "$app_dir/Contents/Resources" "$app_dir/Contents/MacOS"

  local base_png
  base_png=$(_ensure_base_png "$emoji") || {
    _log "render failed for $emoji"
    /bin/rm -rf "$app_dir"
    return 1
  }

  _make_icns "$base_png" "$app_dir/Contents/Resources/AppIcon.icns" || {
    _log "iconutil failed for $code"
    /bin/rm -rf "$app_dir"
    return 1
  }

  _write_info_plist "$app_dir/Contents/Info.plist" "$code" "$name" "$emoji"
  _write_stub_executable "$app_dir/Contents/MacOS/nexus-stub"

  # Touch the bundle so LaunchServices notices the mtime change.
  /usr/bin/touch "$app_dir"

  # Register with LaunchServices so terminal-notifier's -sender lookup
  # resolves the bundle ID to this path.
  if [ -x "$LSREGISTER" ]; then
    "$LSREGISTER" -f "$app_dir" 2>>"$LOG_FILE" || _log "lsregister non-zero for $bundle_id"
  fi

  _log "bundle ready: $bundle_id"
  printf '%s' "$bundle_id"
}

# prime — eagerly create every bundle from a mirrored projects.json.
prime() {
  local cfg="${HOME}/.config/nexus/projects.json"
  if [ ! -f "$cfg" ]; then
    echo "no projects.json at $cfg — copy it from Linux first" >&2
    return 1
  fi
  /usr/bin/jq -r '
    .projects[]
    | select(.icon != null and .name != null)
    | "\(.code)\t\(.icon)\t\(.name)"
  ' "$cfg" | while IFS=$'\t' read -r code emoji name; do
    [ -z "$code" ] && continue
    ensure_bundle "$code" "$emoji" "$name" >/dev/null
    printf 'primed: %s (%s %s)\n' "$code" "$emoji" "$name"
  done
}

case "${1:-}" in
  ensure)
    [ $# -eq 4 ] || { echo "usage: $0 ensure <code> <emoji> <name>" >&2; exit 2; }
    ensure_bundle "$2" "$3" "$4"
    ;;
  ensure-default)
    # Generic Nexus bundle for notifications that have no project scope.
    # Uses the telescope (matching the nx project icon since "Nexus" is
    # the meta-tool's identity). Bundle ID is `dev.priceless.nexus.default`
    # which is distinct from `dev.priceless.nexus.nx` so a notification
    # without a project never visually masquerades as the nx project.
    ensure_bundle "default" "🔭" "Nexus"
    ;;
  prime)
    prime
    ;;
  *)
    cat <<USAGE >&2
usage:
  $0 ensure <code> <emoji> <name>   # create a single bundle
  $0 ensure-default                 # create the generic "Nexus" fallback bundle
  $0 prime                          # batch-create from ~/.config/nexus/projects.json
USAGE
    exit 2
    ;;
esac
