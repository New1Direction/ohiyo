//! Settings the native side has to read without asking the webview: whether closing the
//! window keeps Ohiyo running in the tray, and whether the one-time "still running" hint
//! has been shown. A small JSON file in the app's config folder.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

const PREFS_FILE: &str = "desktop-prefs.json";

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct DesktopPrefs {
    /// Closing the window hides it and the app stays in the tray.
    #[serde(default = "default_keep_running")]
    pub keep_running: bool,
    /// The "Ohiyo is still running" notification has been shown once.
    #[serde(default)]
    pub tray_hint_shown: bool,
}

/// On where a tray is always there (the Mac menu bar). Off on Linux, where many desktops
/// show no tray and a hidden window would look like a crashed app.
fn default_keep_running() -> bool {
    cfg!(target_os = "macos")
}

impl Default for DesktopPrefs {
    fn default() -> Self {
        Self { keep_running: default_keep_running(), tray_hint_shown: false }
    }
}

/// The saved prefs, or the defaults when the file is missing or cannot be read as prefs.
pub fn load(path: &Path) -> DesktopPrefs {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Write through a temp file so a crash mid-write never leaves half a file.
pub fn save(path: &Path, prefs: DesktopPrefs) -> std::io::Result<()> {
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec(&prefs).map_err(std::io::Error::other)?)?;
    std::fs::rename(&temp, path)
}

pub struct PrefsState {
    path: PathBuf,
    current: Mutex<DesktopPrefs>,
}

impl PrefsState {
    pub fn get(&self) -> DesktopPrefs {
        *self.current.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Change the prefs and save them. A failed save keeps the change for this run.
    pub fn update(&self, change: impl FnOnce(&mut DesktopPrefs)) -> DesktopPrefs {
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        change(&mut current);
        if let Err(e) = save(&self.path, *current) {
            eprintln!("[ohiyo] couldn't save desktop prefs: {e}");
        }
        *current
    }
}

pub fn init(app: &AppHandle) {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(PREFS_FILE);
    let current = Mutex::new(load(&path));
    app.manage(PrefsState { path, current });
}

#[tauri::command]
pub fn desktop_prefs_get(state: State<PrefsState>) -> DesktopPrefs {
    state.get()
}

#[tauri::command]
pub fn desktop_prefs_set(state: State<PrefsState>, keep_running: bool) -> DesktopPrefs {
    state.update(|prefs| prefs.keep_running = keep_running)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ohiyo-prefs-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(PREFS_FILE)
    }

    #[test]
    fn a_missing_file_gives_the_platform_default() {
        let prefs = load(&scratch_file("missing"));
        assert_eq!(prefs, DesktopPrefs::default());
        assert_eq!(prefs.keep_running, cfg!(target_os = "macos"));
        assert!(!prefs.tray_hint_shown);
    }

    #[test]
    fn a_damaged_file_gives_the_default_instead_of_failing() {
        let path = scratch_file("damaged");
        for junk in ["", "{", "not json", "[1,2,3]", "{\"keep_running\": \"yes\"}"] {
            std::fs::write(&path, junk).unwrap();
            assert_eq!(load(&path), DesktopPrefs::default(), "{junk:?}");
        }
    }

    #[test]
    fn what_is_saved_is_what_loads() {
        let path = scratch_file("round-trip");
        for keep_running in [true, false] {
            let prefs = DesktopPrefs { keep_running, tray_hint_shown: true };
            save(&path, prefs).unwrap();
            assert_eq!(load(&path), prefs);
        }
    }

    #[test]
    fn a_file_from_an_older_or_newer_version_still_loads() {
        let path = scratch_file("versions");
        // Older: no hint field yet. Newer: a field this version does not know.
        std::fs::write(&path, "{\"keep_running\": false}").unwrap();
        assert_eq!(load(&path), DesktopPrefs { keep_running: false, tray_hint_shown: false });
        std::fs::write(&path, "{\"keep_running\": true, \"tray_hint_shown\": true, \"later\": 3}").unwrap();
        assert_eq!(load(&path), DesktopPrefs { keep_running: true, tray_hint_shown: true });
    }

    #[test]
    fn an_update_is_saved_and_returned() {
        let path = scratch_file("update");
        let state = PrefsState { path: path.clone(), current: Mutex::new(DesktopPrefs::default()) };
        let after = state.update(|prefs| prefs.keep_running = !prefs.keep_running);
        assert_eq!(after.keep_running, !DesktopPrefs::default().keep_running);
        assert_eq!(load(&path), after);
        assert_eq!(state.get(), after);
    }
}
