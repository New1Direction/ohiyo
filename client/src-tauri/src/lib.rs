use tauri::Manager;

mod prefs;
mod tray;
mod vault;

/// Restart the app: "Try again" on the locked vault screen, and after a reset or burn.
/// `request_restart` goes through the normal exit (the Exit event), so plugins such as
/// single-instance clean up before the relaunch; `restart` from a command skips that and
/// the relaunched process could quit instead of starting.
#[tauri::command]
fn app_restart(app: tauri::AppHandle) {
    app.request_restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance must be registered FIRST. A second launch (e.g. opening a
    // ohiyo:// invite link while the app is already running on Windows/Linux, or
    // starting Ohiyo again while it sits in the tray) brings the existing window
    // back instead of spawning a duplicate.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                tray::show_main(app);
            }))
            .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            prefs::init(app.handle());
            // Locked-RAM E2E key vault (replaces on-disk localStorage for the keys). Starts
            // the unlock on its own thread: it can wait on an OS password prompt.
            vault::init(app.handle());
            tray::init(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != tray::MAIN_WINDOW {
                return;
            }
            match event {
                // Closing hides Ohiyo to the tray when "keep running" is on.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if tray::close_action(window.app_handle()) == tray::CloseAction::Hide {
                        api.prevent_close();
                        tray::hide_main(window.app_handle());
                    }
                }
                tauri::WindowEvent::Focused(true) => tray::mark_visible(window.app_handle()),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            vault::vault_available,
            vault::vault_snapshot,
            vault::vault_set,
            vault::vault_remove,
            vault::vault_remove_many,
            vault::vault_reset,
            vault::vault_burn,
            prefs::desktop_prefs_get,
            prefs::desktop_prefs_set,
            tray::desktop_set_unread,
            tray::desktop_set_in_call,
            tray::desktop_autostart_get,
            tray::desktop_autostart_set,
            app_restart,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Ohiyo")
        .run(|app, event| {
            // A click on the Mac Dock icon.
            #[cfg(target_os = "macos")]
            {
                if let tauri::RunEvent::Reopen { .. } = event {
                    tray::show_main(app);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
