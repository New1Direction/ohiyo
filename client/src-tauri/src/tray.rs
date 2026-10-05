//! The tray icon, and what closing the window does. With "keep running" on, closing hides
//! Ohiyo and it stays in the tray, so notifications keep arriving.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;

use crate::prefs::{DesktopPrefs, PrefsState};

pub const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "main";

const EVENT_LEAVE_CALL: &str = "desktop://leave-call";
const EVENT_CHECK_UPDATES: &str = "desktop://check-updates";
const EVENT_WINDOW_HIDDEN: &str = "desktop://window-hidden";

/// How long the window may stay hidden waiting for its page before it is shown anyway.
const REVEAL_FALLBACK: Duration = Duration::from_secs(3);

#[derive(Debug, PartialEq)]
pub enum CloseAction {
    /// Hide; the app keeps running in the tray.
    Hide,
    /// Let the window close, which ends the app.
    Quit,
}

/// What the tray says when the pointer rests on it.
pub fn tooltip(unread: u32) -> String {
    if unread == 0 {
        "Ohiyo".to_string()
    } else {
        format!("Ohiyo, {unread} unread")
    }
}

/// The number on the dock icon; none when everything is read.
pub fn badge(unread: u32) -> Option<i64> {
    (unread > 0).then_some(i64::from(unread))
}

/// What a click on the window's close button does.
pub fn on_close(prefs: DesktopPrefs, has_tray: bool) -> CloseAction {
    if prefs.keep_running && has_tray {
        CloseAction::Hide
    } else {
        CloseAction::Quit
    }
}

/// Where the first-time hint says the app went. Off the Mac it also says how to get the
/// window back, because some Linux desktops show no tray at all.
fn hint_text(is_mac: bool) -> &'static str {
    if is_mac {
        "Ohiyo is still running in the menu bar."
    } else {
        "Ohiyo is still running in the tray. Open Ohiyo again to bring the window back."
    }
}

#[derive(Default)]
pub struct TrayState {
    has_tray: AtomicBool,
    in_call: AtomicBool,
    hidden: AtomicBool,
    /// The window has been shown at least once since launch (see `reveal_main`).
    revealed: AtomicBool,
}

pub fn close_action(app: &AppHandle) -> CloseAction {
    let has_tray = app.state::<TrayState>().has_tray.load(Ordering::Relaxed);
    on_close(app.state::<PrefsState>().get(), has_tray)
}

/// The window is on screen again, however that happened. Tells the app once.
pub fn mark_visible(app: &AppHandle) {
    if app.state::<TrayState>().hidden.swap(false, Ordering::Relaxed) {
        let _ = app.emit(EVENT_WINDOW_HIDDEN, false);
    }
}

/// True for the first caller only.
fn first_reveal(revealed: &AtomicBool) -> bool {
    !revealed.swap(true, Ordering::Relaxed)
}

/// Show the window for the first time after launch. It is created hidden
/// (tauri.conf.json), because a web view paints white until its page's first frame and
/// the window would open as a white sheet. Called when the page has loaded, and by a timer
/// in case it never does. Only the first call shows anything: the page also reports in
/// when it reloads, and by then the person may have closed the window to the tray.
pub fn reveal_main(app: &AppHandle) {
    if first_reveal(&app.state::<TrayState>().revealed) {
        show_main(app);
    }
}

/// Show the window and bring it to the front: the tray's "Open Ohiyo", the Dock icon, a
/// second launch.
pub fn show_main(app: &AppHandle) {
    app.state::<TrayState>().revealed.store(true, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    mark_visible(app);
}

/// Hide to the tray and, the first time ever, say where Ohiyo went.
pub fn hide_main(app: &AppHandle) {
    // On a Mac hide the whole app, as Cmd+H does: then anything that activates Ohiyo
    // (the Dock, Cmd+Tab, a notification) brings the window back by itself.
    #[cfg(target_os = "macos")]
    let _ = app.hide();
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let _ = window.hide();
        }
    }
    app.state::<TrayState>().hidden.store(true, Ordering::Relaxed);
    let _ = app.emit(EVENT_WINDOW_HIDDEN, true);
    let prefs = app.state::<PrefsState>();
    if !prefs.get().tray_hint_shown {
        prefs.update(|p| p.tray_hint_shown = true);
        let hint = hint_text(cfg!(target_os = "macos"));
        let _ = app.notification().builder().title("Ohiyo").body(hint).show();
    }
}

fn autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

fn build_menu(app: &AppHandle, in_call: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "open", "Open Ohiyo", true, None::<&str>)?)?;
    // Only while in a call, so the menu never offers to leave nothing.
    if in_call {
        menu.append(&MenuItem::with_id(app, "leave_call", "Leave call", true, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "check_updates", "Check for updates", true, None::<&str>)?)?;
    menu.append(&CheckMenuItem::with_id(app, "autostart", "Open at login", true, autostart_enabled(app), None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit Ohiyo", true, None::<&str>)?)?;
    Ok(menu)
}

/// Rebuild the menu from what is true now (in a call or not, open at login or not).
fn refresh_menu(app: &AppHandle) {
    let in_call = app.state::<TrayState>().in_call.load(Ordering::Relaxed);
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), build_menu(app, in_call)) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Turn open-at-login on or off. Returns what the system now says.
fn set_autostart(app: &AppHandle, enabled: bool) -> bool {
    let launcher = app.autolaunch();
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    if let Err(e) = result {
        eprintln!("[ohiyo] couldn't change open-at-login: {e}");
    }
    refresh_menu(app);
    autostart_enabled(app)
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip(0))
        .menu(&build_menu(app, false)?)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "leave_call" => {
                let _ = app.emit(EVENT_LEAVE_CALL, ());
            }
            "check_updates" => {
                show_main(app);
                let _ = app.emit(EVENT_CHECK_UPDATES, ());
            }
            "autostart" => {
                set_autostart(app, !autostart_enabled(app));
            }
            "quit" => app.exit(0),
            _ => {}
        });
    // The Mac menu bar wants a one-colour template image; other trays take the app icon.
    #[cfg(target_os = "macos")]
    {
        let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
        builder = builder.icon(icon).icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
    }
    builder.build(app)?;
    Ok(())
}

pub fn init(app: &AppHandle) {
    app.manage(TrayState::default());
    match build_tray(app) {
        Ok(()) => app.state::<TrayState>().has_tray.store(true, Ordering::Relaxed),
        // Creating the tray failed outright: Ohiyo still runs, and closing the window quits.
        // This cannot tell whether a Linux desktop actually shows the tray (GNOME without an
        // extension does not), which is why "keep running" is off there by default and the
        // hint and the setting both say that opening Ohiyo again brings the window back.
        Err(e) => eprintln!("[ohiyo] couldn't create the tray icon: {e}"),
    }
    // The window is shown when its page has loaded (lib.rs). If that never happens, show
    // it anyway: an empty window can be seen and closed, a missing one cannot.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(REVEAL_FALLBACK);
        reveal_main(&app);
    });
}

#[tauri::command]
pub fn desktop_set_unread(app: AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip(count)));
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_badge_count(badge(count));
    }
}

#[tauri::command]
pub fn desktop_set_in_call(app: AppHandle, state: State<TrayState>, in_call: bool) {
    if state.in_call.swap(in_call, Ordering::Relaxed) != in_call {
        refresh_menu(&app);
    }
}

#[tauri::command]
pub fn desktop_autostart_get(app: AppHandle) -> bool {
    autostart_enabled(&app)
}

#[tauri::command]
pub fn desktop_autostart_set(app: AppHandle, enabled: bool) -> bool {
    set_autostart(&app, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEEP: DesktopPrefs = DesktopPrefs { keep_running: true, tray_hint_shown: false };
    const QUIT: DesktopPrefs = DesktopPrefs { keep_running: false, tray_hint_shown: false };

    #[test]
    fn the_window_is_revealed_once_and_a_later_page_load_cannot_bring_it_back() {
        // The page reports that it loaded every time it loads. Only the first report may
        // show the window: after that the person may have closed it to the tray, and a
        // page that reloads there must not pop it back up.
        let revealed = AtomicBool::new(false);
        assert!(first_reveal(&revealed));
        assert!(!first_reveal(&revealed));
        assert!(!first_reveal(&revealed));
    }

    #[test]
    fn the_tooltip_counts_unread_and_is_plain_when_there_are_none() {
        assert_eq!(tooltip(0), "Ohiyo");
        assert_eq!(tooltip(1), "Ohiyo, 1 unread");
        assert_eq!(tooltip(128), "Ohiyo, 128 unread");
    }

    #[test]
    fn the_dock_badge_is_absent_at_zero() {
        assert_eq!(badge(0), None);
        assert_eq!(badge(3), Some(3));
        assert_eq!(badge(u32::MAX), Some(i64::from(u32::MAX)));
    }

    #[test]
    fn closing_hides_only_when_keep_running_is_on() {
        assert_eq!(on_close(KEEP, true), CloseAction::Hide);
        assert_eq!(on_close(QUIT, true), CloseAction::Quit);
    }

    #[test]
    fn without_a_tray_closing_always_quits() {
        // Nothing to click to get the window back: hiding would look like a crash.
        assert_eq!(on_close(KEEP, false), CloseAction::Quit);
        assert_eq!(on_close(QUIT, false), CloseAction::Quit);
    }

    #[test]
    fn the_first_hide_hint_says_how_to_get_the_window_back_where_a_tray_may_be_missing() {
        assert_eq!(hint_text(true), "Ohiyo is still running in the menu bar.");
        // Some Linux desktops show no tray at all, so the hint cannot point only at one.
        assert_eq!(hint_text(false), "Ohiyo is still running in the tray. Open Ohiyo again to bring the window back.");
    }

    #[test]
    fn linux_quits_on_close_unless_the_person_chose_otherwise() {
        let expected = if cfg!(target_os = "macos") { CloseAction::Hide } else { CloseAction::Quit };
        assert_eq!(on_close(DesktopPrefs::default(), true), expected);
    }
}
