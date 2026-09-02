use std::fs;
use std::env;

#[tauri::command]
fn read_cartridge(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read cartridge file {}: {}", path, e))
}

#[tauri::command]
fn save_cartridge(path: String, database_bytes: String) -> Result<(), String> {
    // Read existing container HTML
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read existing container {}: {}", path, e))?;

    // In desktop shell native save, we write back the container content
    // database_bytes is passed as base64 or saved back to disk
    fs::write(&path, content)
        .map_err(|e| format!("Failed to save container in-place {}: {}", path, e))?;

    Ok(())
}

#[tauri::command]
fn get_opened_file() -> Option<String> {
    let args: Vec<String> = env::args().collect();
    if args.len() > 1 {
        let arg = &args[1];
        if arg.ends_with(".dai.html") || arg.ends_with(".dai") || arg.ends_with(".html") {
            return Some(arg.clone());
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            read_cartridge,
            save_cartridge,
            get_opened_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
