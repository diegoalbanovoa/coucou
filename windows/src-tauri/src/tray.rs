// Notification-area icon: Open, Settings, Pause, Quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Wry};

use crate::i18n::{tr, Key, Locale};
use crate::island::WINDOW_LABEL;

const TRAY_ID: &str = "coucou";

fn build_menu(app: &AppHandle, locale: Locale) -> tauri::Result<Menu<Wry>> {
    let open = MenuItem::with_id(app, "open", tr(locale, Key::Open), true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", tr(locale, Key::Settings), true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", tr(locale, Key::Pause), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", tr(locale, Key::Quit), true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(app, &[&open, &sep1, &settings, &pause, &sep2, &quit])
}

pub fn build(app: &AppHandle, locale: Locale) -> tauri::Result<()> {
    let menu = build_menu(app, locale)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Coucou")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// Swaps in a freshly-worded menu — called whenever the language setting
/// changes, so the tray does not need a restart to catch up (see
/// docs/plan-v2.md § 2.3). A no-op before `build` has run, which cannot
/// happen in practice: `setup()` always calls `build` first.
pub fn rebuild(app: &AppHandle, locale: Locale) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    if let Ok(menu) = build_menu(app, locale) {
        let _ = tray.set_menu(Some(menu));
    }
}
