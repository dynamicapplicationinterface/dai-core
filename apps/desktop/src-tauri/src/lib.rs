use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// What the host remembers about a document it has opened before.
///
/// The full SPKI is pinned, not the fingerprint. A fingerprint is a 64-bit
/// truncation, and pinning it would invite a collision search that pinning the
/// whole key removes for nothing. The fingerprint is kept only to show a user.
///
/// `public_key` is None for a document that was unsigned when first seen. That
/// is pinned too: the application inside a container is immutable, so the only
/// legitimate change to a document is its database. A document that arrives
/// signed when it was previously unsigned has changed in a way it should not
/// be able to.
#[derive(Serialize, Deserialize, Clone)]
struct PinnedKey {
    public_key: Option<String>,
    fingerprint: Option<String>,
    app_name: Option<String>,
    /// Unix seconds. Enough to tell a user when they first trusted this.
    first_seen: u64,
}

type Registry = HashMap<String, PinnedKey>;

/// `app_config_dir` rather than beside the cartridge: the registry is the
/// host's memory, not the document's, and a document must never carry the
/// record of whether it is trusted.
fn registry_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("No config directory available: {}", e))?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    Ok(dir.join("trusted-keys.json"))
}

fn read_registry(app: &tauri::AppHandle) -> Result<Registry, String> {
    let path = registry_path(app)?;
    if !path.is_file() {
        return Ok(Registry::new());
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    // A corrupt registry must not be silently discarded: forgetting every pin
    // would turn an impersonation guard into no guard at all, quietly.
    serde_json::from_str(&text).map_err(|e| {
        format!(
            "The trusted-key registry at {} is unreadable ({}). Refusing to              continue rather than treating every cartridge as new.",
            path.display(),
            e
        )
    })
}

/// Written through the same stage-flush-rename path as a cartridge: a
/// half-written registry would lose pins, which fails open.
fn write_registry(app: &tauri::AppHandle, registry: &Registry) -> Result<(), String> {
    let path = registry_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory.", path.display()))?;
    let staging = directory.join(".trusted-keys.json.tmp");

    let json = serde_json::to_string_pretty(registry)
        .map_err(|e| format!("Failed to serialize the registry: {}", e))?;

    {
        let mut file = File::create(&staging)
            .map_err(|e| format!("Failed to stage {}: {}", staging.display(), e))?;
        file.write_all(json.as_bytes())
            .map_err(|e| format!("Failed to write {}: {}", staging.display(), e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to flush {}: {}", staging.display(), e))?;
    }

    fs::rename(&staging, &path).map_err(|e| {
        let _ = fs::remove_file(&staging);
        format!("Failed to replace {}: {}", path.display(), e)
    })
}

/// The key this host has previously seen for a document, if any.
#[tauri::command]
fn get_pinned_key(app: tauri::AppHandle, document_uuid: String) -> Result<Option<PinnedKey>, String> {
    Ok(read_registry(&app)?.get(&document_uuid).cloned())
}

/// Records the key a document was first seen with.
///
/// Deliberately refuses to overwrite an existing pin. Trust on first use means
/// exactly once; a pin that could be replaced by simply opening a file again
/// would protect nothing.
#[tauri::command]
fn pin_key(
    app: tauri::AppHandle,
    document_uuid: String,
    public_key: Option<String>,
    fingerprint: Option<String>,
    app_name: Option<String>,
) -> Result<(), String> {
    let mut registry = read_registry(&app)?;
    if registry.contains_key(&document_uuid) {
        return Err(format!(
            "{} is already pinned. Forget the existing pin before recording a new key.",
            document_uuid
        ));
    }

    registry.insert(
        document_uuid,
        PinnedKey {
            public_key,
            fingerprint,
            app_name,
            first_seen: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        },
    );
    write_registry(&app, &registry)
}

/// Drops a pin, so the next open trusts afresh.
///
/// The escape hatch for a publisher who legitimately rotated keys. Without it a
/// re-signed document would be permanently unopenable, and users faced with
/// that would reach for something worse than an explicit reset.
#[tauri::command]
fn forget_pinned_key(app: tauri::AppHandle, document_uuid: String) -> Result<(), String> {
    let mut registry = read_registry(&app)?;
    registry.remove(&document_uuid);
    write_registry(&app, &registry)
}

#[tauri::command]
fn read_cartridge(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read cartridge file {}: {}", path, e))
}

/// Rejects a path the host cannot save to, before anything is written.
///
/// A browser `File` carries no filesystem path, so a cartridge chosen through
/// an `<input type="file">` arrives as a bare name like `tasks.dai`. Writing
/// that would resolve against the process working directory and either fail or,
/// worse, create a stray file somewhere the user never looked.
fn resolve_target(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);

    if !candidate.is_absolute() {
        return Err(format!(
            "\"{}\" is not a full path, so there is nothing to overwrite. \
             Open the cartridge by double-clicking it, or through the host's \
             file association, so the app knows where it lives.",
            path
        ));
    }

    if !candidate.is_file() {
        return Err(format!("No cartridge exists at {}.", candidate.display()));
    }

    Ok(candidate.to_path_buf())
}

/// Overwrites a cartridge in place with a document the container already sealed.
///
/// The container sends finished HTML rather than raw database bytes. Splicing a
/// new payload here would mean re-zipping the archive, re-digesting every entry
/// and rewriting the manifest — a second implementation of the runtime's
/// resealing, in another language, free to drift out of agreement with it and
/// produce a file that refuses to open.
///
/// The write is staged through a temporary file in the same directory, flushed
/// to the disk itself, and then renamed. A crash midway through a direct write
/// would leave a truncated cartridge, and a cartridge is the user's only copy of
/// their data.
///
/// The `sync_all` is what makes this durable rather than merely atomic. Without
/// it the rename can reach the disk before the contents do, so a power loss
/// between the two leaves a cartridge that looks intact and is empty.
#[tauri::command]
fn save_cartridge(path: String, html: String) -> Result<(), String> {
    if html.trim().is_empty() {
        return Err("The container sent an empty document; refusing to overwrite.".into());
    }

    // Cheap guard against writing something that is not a container at all.
    if !html.contains("id=\"dai-payload\"") {
        return Err(
            "The document sent by the container has no payload; refusing to overwrite.".into(),
        );
    }

    let target = resolve_target(&path)?;

    let directory = target
        .parent()
        .ok_or_else(|| format!("{} has no parent directory.", target.display()))?;

    // Staged in the same directory as the target: a rename across volumes is
    // not atomic, and the temporary directory is often on another one.
    let staging = directory.join(format!(
        ".{}.dai-save",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("cartridge")
    ));

    {
        let mut file = File::create(&staging)
            .map_err(|e| format!("Failed to stage the save at {}: {}", staging.display(), e))?;
        file.write_all(html.as_bytes())
            .map_err(|e| format!("Failed to write {}: {}", staging.display(), e))?;
        // Before the rename, not after: ordering is the whole point.
        file.sync_all()
            .map_err(|e| format!("Failed to flush {} to disk: {}", staging.display(), e))?;
    }

    if let Err(e) = fs::rename(&staging, &target) {
        // Leaving the staging file behind would litter the user's folder with
        // dotfiles after every failed save.
        let _ = fs::remove_file(&staging);
        return Err(format!(
            "Failed to replace {}: {}. The original is unchanged.",
            target.display(),
            e
        ));
    }

    Ok(())
}

#[tauri::command]
fn get_opened_file() -> Option<String> {
    let args: Vec<String> = env::args().collect();
    if args.len() > 1 {
        let arg = &args[1];
        if arg.ends_with(".dai.html") || arg.ends_with(".dai") || arg.ends_with(".html") {
            // Absolute, so a later save knows where to write. A relative
            // argument is resolved now, while the working directory is still
            // the one the launch happened in.
            return fs::canonicalize(arg)
                .map(|p| p.to_string_lossy().replace(r"\\?\", ""))
                .ok()
                .or_else(|| Some(arg.clone()));
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            // A cartridge that fails inside the webview is invisible without
            // this: the container reports into its own DOM, and a blocked
            // bootloader cannot report at all.
            #[cfg(debug_assertions)]
            {
                if let Some(window) = _app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_cartridge,
            save_cartridge,
            get_opened_file,
            get_pinned_key,
            pin_key,
            forget_pinned_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
