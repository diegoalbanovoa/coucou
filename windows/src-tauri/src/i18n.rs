//! What little of the UI is Rust's to say: the tray menu, and (since plan-v2.md
//! § 5.3 asks for it specifically) the paperclip's native file picker's title.
//! The folder picker (`pick_folder`) takes its title from the caller, one
//! `Key` per place it is opened from.
//!
//! `TypeScript` owns the real dictionary (src/i18n/); this is deliberately a
//! much smaller mirror of just a few platform-native strings; a new key here
//! does not need a matching one there, and vice versa.

/// A UI language the Rust side can render. `Settings::language` stores
/// "system", "en" or "es"; `resolve` maps that to one of these the same way
/// `i18n/index.ts`'s `resolveLocale` does, falling back to `En`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    En,
    Es,
}

impl Locale {
    /// `setting` is `Settings.language` as stored: "system", "en" or "es".
    /// "system" reads `platform::system_locale()` — no new dependency; see
    /// that function on each platform (GetUserDefaultLocaleName on Windows,
    /// $LC_ALL/$LC_MESSAGES/$LANG on Linux).
    pub fn resolve(setting: &str) -> Self {
        match setting {
            "es" => Locale::Es,
            "en" => Locale::En,
            _ => {
                if crate::platform::system_locale().is_some_and(|l| l.to_lowercase().starts_with("es")) {
                    Locale::Es
                } else {
                    Locale::En
                }
            }
        }
    }
}

/// A native string Rust renders itself (tray menu items and dialog titles).
pub enum Key {
    /// Tray item that shows the island.
    Open,
    /// Tray item that opens the Settings window.
    Settings,
    /// Tray item that pauses or resumes Mochi.
    Pause,
    /// Tray item that exits the app.
    Quit,
    /// Title bar of the paperclip's native multi-select picker.
    AttachFiles,
    /// Title bar of the picker that adds an app to the quick assistant.
    ChooseApp,
    /// Title bar of the folder picker that attaches a project to the chat.
    AttachProject,
    /// Title bar of the picker that chooses the notes vault by hand.
    ChooseVault,
    /// Title bar of the picker for the chat's default folder.
    ChooseChatFolder,
    /// Title bar of the picker that allows a folder to the quick assistant.
    AllowFolder,
    /// Title bar of the picker that imports a skill.
    ChooseSkill,
}

/// Translates `key` into `locale`. Exhaustive match: adding a `Key` or
/// `Locale` without both strings fails to compile.
pub fn tr(locale: Locale, key: Key) -> &'static str {
    match (locale, key) {
        (Locale::En, Key::Open) => "Open Coucou",
        (Locale::Es, Key::Open) => "Abrir Coucou",
        (Locale::En, Key::Settings) => "Settings…",
        (Locale::Es, Key::Settings) => "Ajustes…",
        (Locale::En, Key::Pause) => "Pause",
        (Locale::Es, Key::Pause) => "Pausar",
        (Locale::En, Key::Quit) => "Quit",
        (Locale::Es, Key::Quit) => "Salir",
        (Locale::En, Key::AttachFiles) => "Attach files",
        (Locale::Es, Key::AttachFiles) => "Adjuntar archivos",
        (Locale::En, Key::ChooseApp) => "Choose an app",
        (Locale::Es, Key::ChooseApp) => "Elegir una aplicación",
        (Locale::En, Key::AttachProject) => "Attach a project folder",
        (Locale::Es, Key::AttachProject) => "Adjuntar la carpeta de un proyecto",
        (Locale::En, Key::ChooseVault) => "Choose your notes vault",
        (Locale::Es, Key::ChooseVault) => "Elige tu bóveda de notas",
        (Locale::En, Key::ChooseChatFolder) => "Choose the default chat folder",
        (Locale::Es, Key::ChooseChatFolder) => "Elige la carpeta predeterminada del chat",
        (Locale::En, Key::AllowFolder) => "Allow a folder",
        (Locale::Es, Key::AllowFolder) => "Permitir una carpeta",
        (Locale::En, Key::ChooseSkill) => "Choose a skill folder",
        (Locale::Es, Key::ChooseSkill) => "Elige la carpeta de una skill",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_key_answers_in_both_locales() {
        for key in [Key::Open, Key::Settings, Key::Pause, Key::Quit, Key::AttachFiles, Key::ChooseApp, Key::AttachProject, Key::ChooseVault, Key::ChooseChatFolder, Key::AllowFolder, Key::ChooseSkill] {
            assert!(!tr(Locale::En, key_copy(&key)).is_empty());
            assert!(!tr(Locale::Es, key).is_empty());
        }
    }

    // `Key` carries no data, so a second copy for the English half of the
    // pair above is just this — cheaper than deriving Clone for an enum nothing else needs it on.
    fn key_copy(key: &Key) -> Key {
        match key {
            Key::Open => Key::Open,
            Key::Settings => Key::Settings,
            Key::Pause => Key::Pause,
            Key::Quit => Key::Quit,
            Key::AttachFiles => Key::AttachFiles,
            Key::ChooseApp => Key::ChooseApp,
            Key::AttachProject => Key::AttachProject,
            Key::ChooseVault => Key::ChooseVault,
            Key::ChooseChatFolder => Key::ChooseChatFolder,
            Key::AllowFolder => Key::AllowFolder,
            Key::ChooseSkill => Key::ChooseSkill,
        }
    }

    #[test]
    fn an_explicit_setting_wins_over_the_system_locale() {
        assert!(Locale::resolve("en") == Locale::En);
        assert!(Locale::resolve("es") == Locale::Es);
    }
}
