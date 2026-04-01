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

/// Ensure `Nexus-Notifier.app` exists at `~/.local/share/Nexus-Notifier.app`.
///
/// This is a copy of terminal-notifier.app with the icon replaced by the Nexus NX
/// icon and the bundle identifier changed to `com.nexus.notifier`. macOS shows the
/// **sending app's bundle icon** in Notification Center — `-appIcon` is unreliable
/// on modern macOS, so we bake the icon directly into the .app bundle.
///
/// Called once at agent startup. macOS-only.
pub fn ensure_app_bundle() {
    if !cfg!(target_os = "macos") {
        return;
    }

    let home = nexus_core::paths::home_dir();
    let notifier_app = home.join(".local/share/Nexus-Notifier.app");
    let notifier_icns = notifier_app.join("Contents/Resources/Terminal.icns");

    // Skip if already set up (check for our icon, not terminal-notifier's default)
    if notifier_app.exists() && notifier_icns.exists() {
        // Quick size check — our icon is ~8KB, terminal-notifier's default is ~360KB
        if let Ok(meta) = std::fs::metadata(&notifier_icns) {
            if meta.len() < 50_000 {
                debug!("Nexus-Notifier.app already exists with custom icon");
                return;
            }
        }
    }

    // Find the source terminal-notifier.app
    let source_app = find_terminal_notifier_app();
    let Some(source) = source_app else {
        warn!("terminal-notifier.app not found — cannot create Nexus-Notifier.app");
        return;
    };

    debug!("Creating Nexus-Notifier.app from {}", source.display());

    // Copy the entire .app bundle
    let _ = std::fs::remove_dir_all(&notifier_app);
    if let Err(e) = copy_dir_recursive(&source, &notifier_app) {
        warn!("Failed to copy terminal-notifier.app: {}", e);
        return;
    }

    // Create our .icns from the embedded PNG
    let cache_dir = cache_dir();
    let _ = std::fs::create_dir_all(&cache_dir);
    let png_path = cache_dir.join("nexus.png");
    let _ = std::fs::write(&png_path, DEFAULT_ICON);

    if create_icns_from_png(&png_path, &notifier_icns) {
        debug!("Replaced icon with Nexus .icns");
    } else {
        warn!("Failed to create .icns — notifications will use terminal icon");
    }

    // Update bundle identifier so it doesn't conflict with terminal-notifier
    let plist_path = notifier_app.join("Contents/Info.plist");
    let _ = std::process::Command::new("plutil")
        .args(["-replace", "CFBundleIdentifier", "-string", "com.nexus.notifier"])
        .arg(&plist_path)
        .output();
    let _ = std::process::Command::new("plutil")
        .args(["-replace", "CFBundleName", "-string", "Nexus"])
        .arg(&plist_path)
        .output();

    // Register with Launch Services
    let _ = std::process::Command::new("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister")
        .arg("-f")
        .arg(&notifier_app)
        .output();

    tracing::info!("Nexus-Notifier.app created and registered");
}

/// Locate terminal-notifier.app on the system.
fn find_terminal_notifier_app() -> Option<std::path::PathBuf> {
    // Homebrew Cellar (most common)
    let cellar = std::path::PathBuf::from("/opt/homebrew/Cellar/terminal-notifier");
    if cellar.exists() {
        if let Ok(entries) = std::fs::read_dir(&cellar) {
            for entry in entries.flatten() {
                let app = entry.path().join("terminal-notifier.app");
                if app.exists() {
                    return Some(app);
                }
            }
        }
    }
    // Intel Mac homebrew
    let cellar_intel = std::path::PathBuf::from("/usr/local/Cellar/terminal-notifier");
    if cellar_intel.exists() {
        if let Ok(entries) = std::fs::read_dir(&cellar_intel) {
            for entry in entries.flatten() {
                let app = entry.path().join("terminal-notifier.app");
                if app.exists() {
                    return Some(app);
                }
            }
        }
    }
    None
}

/// Recursively copy a directory.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
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
