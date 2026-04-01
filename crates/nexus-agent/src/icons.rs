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
