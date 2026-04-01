//! Bundled notification icons for macOS desktop notifications.
//!
//! Each project gets a distinct icon embedded via `include_bytes!` at compile time.
//! At runtime, icons are extracted to `~/.cache/nexus/icons/` and the path is
//! passed to `terminal-notifier -appIcon`.

use std::path::PathBuf;
use tracing::{debug, warn};

/// Default Nexus icon (dark bg, blue "NX" text).
const DEFAULT_ICON: &[u8] = include_bytes!("../../../deploy/assets/icons/nexus.png");

/// Get the embedded icon bytes for a project code.
/// Falls back to the default Nexus icon for unknown codes.
fn get_icon_bytes(code: &str) -> &'static [u8] {
    match code.to_lowercase().as_str() {
        "ba" => include_bytes!("../../../deploy/assets/icons/ba.png"),
        "bo" => include_bytes!("../../../deploy/assets/icons/bo.png"),
        "cc" => include_bytes!("../../../deploy/assets/icons/cc.png"),
        "cl" => include_bytes!("../../../deploy/assets/icons/cl.png"),
        "co" => include_bytes!("../../../deploy/assets/icons/co.png"),
        "ct" => include_bytes!("../../../deploy/assets/icons/ct.png"),
        "cw" => include_bytes!("../../../deploy/assets/icons/cw.png"),
        "cx" => include_bytes!("../../../deploy/assets/icons/cx.png"),
        "dc" => include_bytes!("../../../deploy/assets/icons/dc.png"),
        "es" => include_bytes!("../../../deploy/assets/icons/es.png"),
        "ew" => include_bytes!("../../../deploy/assets/icons/ew.png"),
        "fb" => include_bytes!("../../../deploy/assets/icons/fb.png"),
        "hl" => include_bytes!("../../../deploy/assets/icons/hl.png"),
        "ic" => include_bytes!("../../../deploy/assets/icons/ic.png"),
        "if" => include_bytes!("../../../deploy/assets/icons/if.png"),
        "la" => include_bytes!("../../../deploy/assets/icons/la.png"),
        "lu" => include_bytes!("../../../deploy/assets/icons/lu.png"),
        "lv" => include_bytes!("../../../deploy/assets/icons/lv.png"),
        "mv" => include_bytes!("../../../deploy/assets/icons/mv.png"),
        "nv" => include_bytes!("../../../deploy/assets/icons/nv.png"),
        "nx" => include_bytes!("../../../deploy/assets/icons/nx.png"),
        "oo" => include_bytes!("../../../deploy/assets/icons/oo.png"),
        "pb" => include_bytes!("../../../deploy/assets/icons/pb.png"),
        "pp" => include_bytes!("../../../deploy/assets/icons/pp.png"),
        "sc" => include_bytes!("../../../deploy/assets/icons/sc.png"),
        "se" => include_bytes!("../../../deploy/assets/icons/se.png"),
        "sj" => include_bytes!("../../../deploy/assets/icons/sj.png"),
        "ss" => include_bytes!("../../../deploy/assets/icons/ss.png"),
        "tb" => include_bytes!("../../../deploy/assets/icons/tb.png"),
        "tc" => include_bytes!("../../../deploy/assets/icons/tc.png"),
        "tl" => include_bytes!("../../../deploy/assets/icons/tl.png"),
        "tm" => include_bytes!("../../../deploy/assets/icons/tm.png"),
        "ws" => include_bytes!("../../../deploy/assets/icons/ws.png"),
        "zune" => include_bytes!("../../../deploy/assets/icons/zune.png"),
        _ => DEFAULT_ICON,
    }
}

/// Cache directory for extracted icons.
fn cache_dir() -> PathBuf {
    nexus_core::paths::home_dir()
        .join(".cache")
        .join("nexus")
        .join("icons")
}

/// Get the cached icon path for a project code, extracting from embedded
/// bytes on first use. Returns `None` if the cache directory cannot be created
/// or the icon cannot be written (graceful degradation).
pub fn get_icon_path(code: &str) -> Option<PathBuf> {
    let dir = cache_dir();
    let code_lower = code.to_lowercase();
    let filename = if code_lower.is_empty() || code_lower == "global" {
        "nexus.png".to_string()
    } else {
        format!("{}.png", code_lower)
    };
    let path = dir.join(&filename);

    // If cached file exists, return immediately
    if path.exists() {
        return Some(path);
    }

    // Create cache directory
    if let Err(e) = std::fs::create_dir_all(&dir) {
        debug!("Failed to create icon cache dir {}: {}", dir.display(), e);
        return None;
    }

    // Write icon bytes to cache
    let bytes = get_icon_bytes(&code_lower);
    match std::fs::write(&path, bytes) {
        Ok(()) => {
            debug!("Cached icon for '{}' at {}", code, path.display());
            Some(path)
        }
        Err(e) => {
            warn!("Failed to write icon cache {}: {}", path.display(), e);
            None
        }
    }
}

/// Ensure the Nexus.app bundle exists at `~/.local/share/Nexus.app` so that
/// `terminal-notifier -sender com.nexus.agent` shows our icon in Notification Center.
///
/// This is a macOS-only concern — on Linux, notify-send uses different icon mechanisms.
/// Called once at agent startup.
pub fn ensure_app_bundle() {
    if !cfg!(target_os = "macos") {
        return;
    }

    let home = nexus_core::paths::home_dir();
    let app_dir = home.join(".local/share/Nexus.app/Contents");
    let icns_path = app_dir.join("Resources/AppIcon.icns");
    let plist_path = app_dir.join("Info.plist");

    // Skip if already set up
    if icns_path.exists() && plist_path.exists() {
        debug!("Nexus.app bundle already exists");
        return;
    }

    debug!("Creating Nexus.app bundle for notification icons");

    // Create directory structure
    for subdir in ["MacOS", "Resources"] {
        if let Err(e) = std::fs::create_dir_all(app_dir.join(subdir)) {
            warn!("Failed to create Nexus.app dirs: {}", e);
            return;
        }
    }

    // Write Info.plist
    let plist = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.nexus.agent</string>
    <key>CFBundleName</key>
    <string>Nexus</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>"#;

    if let Err(e) = std::fs::write(&plist_path, plist) {
        warn!("Failed to write Nexus.app Info.plist: {}", e);
        return;
    }

    // Write the default nexus icon as a PNG to Resources/
    // (terminal-notifier can use PNG directly via -appIcon as fallback)
    let png_path = app_dir.join("Resources/AppIcon.png");
    if let Err(e) = std::fs::write(&png_path, DEFAULT_ICON) {
        warn!("Failed to write Nexus.app icon PNG: {}", e);
        return;
    }

    // Try to create .icns from PNG using sips + iconutil (macOS only)
    if create_icns_from_png(&png_path, &icns_path) {
        debug!("Created Nexus.app with .icns icon");
    } else {
        debug!("Created Nexus.app with PNG fallback (iconutil unavailable)");
    }

    // Register with Launch Services
    let _ = std::process::Command::new("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister")
        .arg("-f")
        .arg(app_dir.parent().unwrap())
        .output();

    tracing::info!("Nexus.app bundle created and registered for notification icons");
}

/// Convert a PNG to .icns using macOS sips + iconutil.
fn create_icns_from_png(png: &std::path::Path, icns: &std::path::Path) -> bool {
    let tmp_dir = std::env::temp_dir().join("nexus-iconset");
    let iconset = tmp_dir.join("AppIcon.iconset");

    let _ = std::fs::remove_dir_all(&iconset);
    if std::fs::create_dir_all(&iconset).is_err() {
        return false;
    }

    // Create required icon sizes via sips
    let sizes = [(16, "icon_16x16"), (32, "icon_32x32"), (64, "icon_64x64"), (128, "icon_128x128")];
    for (size, name) in &sizes {
        let out = iconset.join(format!("{name}.png"));
        let ok = std::process::Command::new("sips")
            .args(["-z", &size.to_string(), &size.to_string()])
            .arg(png)
            .arg("--out")
            .arg(&out)
            .output()
            .is_ok();
        if !ok {
            return false;
        }
    }

    // Retina variants
    for (size, name) in [(32, "icon_16x16@2x"), (64, "icon_32x32@2x"), (128, "icon_64x64@2x")] {
        let out = iconset.join(format!("{name}.png"));
        let _ = std::fs::copy(iconset.join(format!("icon_{size}x{size}.png")), &out);
    }

    // Build .icns
    let result = std::process::Command::new("iconutil")
        .args(["-c", "icns"])
        .arg(&iconset)
        .arg("-o")
        .arg(icns)
        .output();

    let _ = std::fs::remove_dir_all(&tmp_dir);
    matches!(result, Ok(out) if out.status.success())
}
