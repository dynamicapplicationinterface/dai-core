use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

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
fn save_cartridge(path: String, html: String, backup: bool) -> Result<(), String> {
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

    // The rename below is atomic, so this file is never half-written — but the
    // version it replaces is gone all the same, and a person who has just
    // overwritten a document wants the same way back as one whose save was
    // interrupted.
    if backup {
        write_backup(&target)?;
    }

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

/// Copies a document beside itself before it is written over.
///
/// An in-place save cannot be atomic, and the ordering that makes a crash
/// *detectable* does not make it recoverable: the previous database is gone the
/// moment the new one starts being written. A copy is the only thing that
/// changes that, and one copy per session is the price — every save would be
/// absurd for a file this format expects to be large, and no copy at all leaves
/// somebody with a document that reports its own data as damaged and nothing to
/// go back to.
///
/// Staged and renamed like every other write here, so a crash midway cannot
/// replace a good backup with half of one.
fn write_backup(target: &Path) -> Result<(), String> {
    let directory = target
        .parent()
        .ok_or_else(|| format!("{} has no parent directory.", target.display()))?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document");

    let staging = directory.join(format!(".{}.bak-writing", name));
    let backup = directory.join(format!("{}.bak", name));

    fs::copy(target, &staging)
        .map_err(|e| format!("Failed to copy {} before saving: {}", target.display(), e))?;

    if let Err(e) = fs::rename(&staging, &backup) {
        let _ = fs::remove_file(&staging);
        return Err(format!("Failed to write {}: {}", backup.display(), e));
    }

    Ok(())
}

/// Reads a cartridge as bytes, base64-encoded for the bridge.
///
/// The sectioned form is binary, so `read_cartridge` cannot carry it: reading
/// it as a string either fails or silently replaces every byte that is not
/// valid UTF-8, which is most of a SQLite database. The frontend decides which
/// form it has from the leading bytes, never from the extension.
#[tauri::command]
fn read_cartridge_bytes(path: String) -> Result<String, String> {
    let bytes = fs::read(&path)
        .map_err(|e| format!("Failed to read cartridge file {}: {}", path, e))?;
    Ok(BASE64.encode(bytes))
}

/// Saves a sectioned cartridge by writing only its database.
///
/// The counterpart to `save_cartridge`, which rewrites a whole viewer-form
/// document. Here the manifest and the payload are left untouched — not as an
/// optimisation, but because the publisher's signature covers them and a save
/// carries no key to sign with. See `sectioned` for the ordering guarantees.
///
/// Returns the generation the file now carries, so the frontend can show that a
/// save actually advanced the document rather than reporting a bare "ok" — and
/// so it can pass that number back on the next save.
#[tauri::command]
fn save_cartridge_data(
    path: String,
    data_base64: String,
    expected_generation: Option<u64>,
    backup: bool,
) -> Result<u64, String> {
    let data = BASE64
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("The database sent by the container is not valid base64: {}", e))?;

    let target = resolve_target(&path)?;

    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&target)
        .map_err(|e| format!("Failed to open {} for writing: {}", target.display(), e))?;

    // Taken before anything is read or written, and held until this handle
    // drops. Another process saving the same document is refused with a code
    // rather than made to wait or, worse, allowed through.
    dai_sectioned::lock_exclusive(&file)?;

    let size = file
        .metadata()
        .map_err(|e| format!("Failed to measure {}: {}", target.display(), e))?
        .len();

    if backup {
        write_backup(&target)?;
    }

    match expected_generation {
        // Guarded when the frontend knows which save it read, which is every
        // time it opened the file itself. Two windows on one document have no
        // lock; this is the half that needs none, because the footer already
        // counts saves.
        Some(expected) => {
            dai_sectioned::replace_data_if_unchanged(&mut file, size, &data, expected)
        }
        None => dai_sectioned::replace_data(&mut file, size, &data),
    }
}

/// The cartridge this process was launched with, if any.
///
/// Every argument is scanned rather than just the first. A shell, a launcher
/// script or the OS may insert flags ahead of the path, and indexing blindly
/// would read a flag, find no cartridge, and leave a double-click looking like
/// it did nothing at all.
/// Picks the cartridge out of a set of command-line arguments.
///
/// Shared by the startup path and by a forwarded second launch, so both agree
/// on what counts as a cartridge argument.
fn cartridge_argument<I: Iterator<Item = String>>(args: I) -> Option<String> {
    for arg in args {
        if arg.starts_with('-') {
            continue;
        }
        let lower = arg.to_lowercase();
        if !(lower.ends_with(".dai") || lower.ends_with(".html")) {
            continue;
        }
        if !Path::new(&arg).is_file() {
            continue;
        }

        // Absolute, so a later save knows where to write. Resolved now, while
        // the working directory is still the one the launch happened in.
        return Some(
            fs::canonicalize(&arg)
                .map(|p| {
                    // Windows canonicalization adds a verbatim prefix that
                    // other APIs, and anything shown to a user, handle badly.
                    p.to_string_lossy()
                        .trim_start_matches(r"\\?\")
                        .to_string()
                })
                .unwrap_or(arg),
        );
    }
    None
}

#[tauri::command]
fn get_opened_file() -> Option<String> {
    cartridge_argument(env::args().skip(1))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Registered first, as the plugin requires: a later registration would
        // let the second process get further into startup before being told to
        // stop, and it is the early work — touching the trust registry — that
        // must not happen twice.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch hands its arguments here and then exits. Bring the
            // existing window forward, or the file appears to open into nothing.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }

            if let Some(path) = cartridge_argument(argv.into_iter().skip(1)) {
                // The frontend owns opening: it runs verification and the trust
                // check, and duplicating that here would be a second gate free
                // to disagree with the first.
                let _ = app.emit("dai://open-cartridge", path);
            }
        }))
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
            read_cartridge_bytes,
            save_cartridge,
            save_cartridge_data,
            get_opened_file,
            get_pinned_key,
            pin_key,
            forget_pinned_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{cartridge_argument, write_backup};
    use std::fs;
    use std::path::PathBuf;

    /// Creates a real file, since the scanner deliberately requires one: an
    /// argument that names nothing is not a cartridge, however it is spelled.
    fn touch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(name);
        fs::write(&path, "<script id=\"dai-payload\"></script>").unwrap();
        path
    }

    fn args(values: &[&str]) -> impl Iterator<Item = String> {
        values.iter().map(|v| v.to_string()).collect::<Vec<_>>().into_iter()
    }

    #[test]
    fn backs_a_document_up_before_writing_over_it() {
        /*
         * The only thing that makes an interrupted in-place save recoverable.
         * The ordering makes a crash detectable; a copy is what makes it
         * survivable, and there was none.
         */
        let dir = std::env::temp_dir().join(format!("dai-backup-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let document = dir.join("notes.dai");
        fs::write(&document, b"the bytes before any save").unwrap();

        write_backup(&document).unwrap();

        let backup = dir.join("notes.dai.bak");
        assert_eq!(fs::read(&backup).unwrap(), b"the bytes before any save");

        // Nothing left behind from the staging step.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("bak-writing"))
            .collect();
        assert!(leftovers.is_empty(), "staging file left behind: {:?}", leftovers);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_backup_replaces_the_first() {
        // One copy per session, so the backup is of the state this window
        // opened rather than of whatever it wrote a moment ago.
        let dir = std::env::temp_dir().join(format!("dai-backup2-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let document = dir.join("notes.dai");

        fs::write(&document, b"first").unwrap();
        write_backup(&document).unwrap();
        fs::write(&document, b"second").unwrap();
        write_backup(&document).unwrap();

        assert_eq!(fs::read(dir.join("notes.dai.bak")).unwrap(), b"second");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_a_cartridge_argument() {
        let file = touch("dai-test-plain.dai");
        let found = cartridge_argument(args(&[file.to_str().unwrap()]));
        assert!(found.unwrap().ends_with("dai-test-plain.dai"));
    }

    #[test]
    fn skips_flags_before_the_path() {
        // tauri dev passes its own arguments ahead of the file, and a launcher
        // script may add more. Indexing blindly would read a flag and give up.
        let file = touch("dai-test-flagged.dai");
        let found = cartridge_argument(args(&[
            "--no-sandbox",
            "-v",
            "--flag=value",
            file.to_str().unwrap(),
        ]));
        assert!(found.unwrap().ends_with("dai-test-flagged.dai"));
    }

    #[test]
    fn accepts_the_double_extension_form() {
        let file = touch("dai-test-double.dai.html");
        assert!(cartridge_argument(args(&[file.to_str().unwrap()])).is_some());
    }

    #[test]
    fn ignores_an_argument_naming_no_file() {
        // A path that does not exist is not a cartridge. Returning it would push
        // the failure into read_cartridge, where the message is less useful.
        assert!(cartridge_argument(args(&["C:/nowhere/absent.dai"])).is_none());
    }

    #[test]
    fn ignores_unrelated_extensions() {
        let file = touch("dai-test-notes.txt");
        assert!(cartridge_argument(args(&[file.to_str().unwrap()])).is_none());
    }

    #[test]
    fn returns_an_absolute_path() {
        // A later save needs somewhere definite to write, and the working
        // directory may have changed by then.
        let file = touch("dai-test-absolute.dai");
        let found = cartridge_argument(args(&[file.to_str().unwrap()])).unwrap();
        assert!(PathBuf::from(&found).is_absolute());
        // The verbatim prefix breaks other APIs and reads badly to a user.
        assert!(!found.starts_with(r"\?\"));
    }

    #[test]
    fn takes_the_first_cartridge_when_several_are_given() {
        let first = touch("dai-test-first.dai");
        let second = touch("dai-test-second.dai");
        let found = cartridge_argument(args(&[
            first.to_str().unwrap(),
            second.to_str().unwrap(),
        ]));
        assert!(found.unwrap().ends_with("dai-test-first.dai"));
    }
}
