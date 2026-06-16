use tauri::Manager;

mod vault;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance must be registered FIRST. A second launch (e.g. opening a
    // ohiyo:// invite link while the app is already running on Windows/Linux)
    // focuses the existing window instead of spawning a duplicate.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // Locked-RAM E2E key vault (replaces on-disk localStorage for the keys).
        .setup(|app| {
            vault::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault::vault_available,
            vault::vault_snapshot,
            vault::vault_set,
            vault::vault_remove,
            vault::vault_burn,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ohiyo");
}
