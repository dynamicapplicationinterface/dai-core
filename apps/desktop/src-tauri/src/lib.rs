use std::env;
use std::fs;
use std::path::{Path, PathBuf};

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
/// The write is staged through a temporary file in the same directory and then
/// renamed. A crash midway through a direct write would leave a truncated
/// cartridge, and a cartridge is the user's only copy of their data.
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

    fs::write(&staging, html.as_bytes())
        .map_err(|e| format!("Failed to stage the save at {}: {}", staging.display(), e))?;

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
        .setup(|_app| {
            // A cartridge that fails inside the webview is invisible without
            // this: the container reports into its own DOM, and a blocked
            // bootloader cannot report at all.
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_cartridge,
            save_cartridge,
            get_opened_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
