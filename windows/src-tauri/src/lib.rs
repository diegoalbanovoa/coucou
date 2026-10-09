// Coucou for Windows — app wiring and the commands the island calls.

mod agent;
mod agents;
mod consoles;
mod files;
mod hooks;
mod integrations;
mod island;
mod log;
mod pipe;
mod platform;
mod secrets;
mod settings;
mod system;
mod transcript;
mod tray;
mod vault;

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    settings.hooks_installed = hooks::status().installed;
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        cursor_poll: platform::CURSOR_POLL,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, autostart_changed, switched_on) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        // Which integrations were just switched on. Their pollers are waiting
        // on the long idle cadence, so without this the first data would be up
        // to five minutes away.
        let switched_on: Vec<String> = settings
            .active_integrations
            .iter()
            .filter(|id| !current.active_integrations.contains(id))
            .cloned()
            .collect();
        *current = settings.clone();
        (screen_changed, autostart_changed, switched_on)
    };
    for id in switched_on {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            integrations::poll_once(handle, &id).await;
        });
    }
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[coucou] autostart: {err}");
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// Applies a change to the stored settings and writes it out.
///
/// This is for the state the app remembers on its own — the attached project,
/// the chosen CLI, the conversation in flight — as opposed to `save_settings`,
/// which is the user editing their preferences in the settings window. The file
/// is written outside the lock: saving is IO, and the island reads settings on
/// every frame it draws.
fn remember(app: &AppHandle, change: impl FnOnce(&mut Settings)) {
    let settings = {
        let shared = app.state::<Shared>();
        let mut current = shared.settings.lock().unwrap();
        change(&mut current);
        current.clone()
    };
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    let _ = app.emit("settings-changed", settings);
}

/// A copy of the settings, taken and released rather than held: everything
/// that reads them does so from a command, and a lock across an await would
/// stop the island drawing.
fn shared_settings(app: &AppHandle) -> Settings {
    app.state::<Shared>().settings.lock().unwrap().clone()
}

/// Makes the autostart registration agree with the stored preference.
///
/// The switch in the settings window only acts when the value changes, so a
/// preference that was never applied would never take effect: the default on a
/// fresh install, or a registration removed behind our back by another tool. An
/// app whose whole job is to be there when something needs answering cannot
/// depend on the user having toggled a switch once.
fn reconcile_autostart(app: &AppHandle, wanted: bool) {
    // Nothing running out of the build tree may own the login entry. A debug
    // build takes its page from the Vite dev server, so it would start
    // something that cannot draw; a release build run from target/release is a
    // real app but at a path `cargo clean` deletes. Either way the entry would
    // outlive what it points at. The preference is left alone — it applies to
    // the build that ships, from where the installer puts it.
    let from_build_tree = std::env::current_exe()
        .map(|exe| exe.components().any(|part| part.as_os_str() == "target"))
        .unwrap_or(false);
    if cfg!(debug_assertions) || from_build_tree {
        log::line(format!(
            "autostart left alone: a build-tree copy must not own it (want {wanted})"
        ));
        return;
    }

    let manager = app.autolaunch();
    let result = if wanted {
        // Written on every boot rather than only on a change. `enable` stamps
        // the path of the executable running now, which is the only thing that
        // corrects an entry left behind by an older install or another build —
        // `is_enabled` answers whether there is an entry, never whether it
        // points at us.
        manager.enable()
    } else {
        match manager.is_enabled() {
            // Nothing registered and nothing wanted: leave the registry alone.
            Ok(false) => return,
            _ => manager.disable(),
        }
    };
    match result {
        Ok(()) => log::line(format!("autostart set to {wanted}")),
        Err(err) => log::line(format!("could not set autostart: {err}")),
    }
}

/// Brings back the project — and the conversation inside it — the app was in
/// when it last ran, so a restart is not a blank chat with nothing attached.
fn restore_agent(app: &AppHandle, settings: &Settings) {
    // Nothing remembered falls through to the default folder, so a fresh
    // install with one configured opens on it rather than on nothing.
    let Some(stored) = settings
        .project_root
        .as_deref()
        .or(settings.default_chat_folder.as_deref())
    else {
        return;
    };
    match app.state::<agent::Project>().attach(stored) {
        Ok(name) => {
            log::line(format!("agent project restored: {name}"));
            // Only a project that actually came back makes the old conversation
            // worth resuming: the session ran inside it, and `--resume` in the
            // wrong folder is worse than a fresh start.
            if let Some(id) = settings.agent_session.clone() {
                app.state::<agent::Session>().set(id);
            }
        }
        // Left in settings rather than cleared: a folder on a drive that is not
        // mounted yet is the usual reason, and it will be back next time.
        Err(err) => log::line(format!("agent project {stored} not restored: {err}")),
    }
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

/// "Open terminal" opens the working folder in VS Code when `code` is on PATH,
/// and falls back to the file manager otherwise.
#[tauri::command]
fn open_in_vscode(path: Option<String>) -> bool {
    // No shell anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and a shell would happily read `&`, `^`, `%`
    // or `$` in a folder name as syntax. Finding the launcher ourselves and
    // handing the path over as a separate argument keeps it a path.
    let path = path.filter(|p| !p.is_empty());
    // It arrives in a hook payload: only an existing folder, given by its full
    // path, goes any further. `code` would read `--something` as an option, and
    // xdg-open would launch a file with whatever handles its type.
    if let Some(p) = path.as_deref() {
        let p = std::path::Path::new(p);
        if !(p.is_absolute() && p.is_dir()) {
            return false;
        }
    }
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref() {
            cmd.arg(p);
        }
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref() {
        platform::reveal_folder(p);
    }
    false
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        if let Err(err) = settings::save(&current) {
            log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    pipe::decline(&app, &request_id);
}

// ── Files and secrets ─────────────────────────────────────────────────────────

// ── Agent chat: the installed CLIs, in an attached project ────────────────────

/// Which agent CLIs are on this machine. The island shows these in the picker
/// above the chat box, next to the API models.
#[tauri::command]
fn agent_clis(app: AppHandle) -> Vec<consoles::Console> {
    // Now is when Coucou knows where each CLI is, so now is when each one's
    // config file is written or brought up to date.
    consoles::map_configs();
    // The versions are filled in behind this and sent on when they land: a
    // CLI installed as an npm shim can take seconds to answer `--version`, and
    // the start screen lists the agents before any of them has spoken.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(full) = consoles::versions().await {
            let _ = handle.emit("agent-clis", full);
        }
    });
    consoles::installed()
}

/// What the chat should come up in: the project and CLI that were in use when
/// the app last ran. Asked for once at boot, after `agent_clis`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentState {
    /// The attached project, as it should be shown, or null for none.
    project: Option<String>,
    /// The CLI the chat runs, by id, or null when none has been chosen.
    cli: Option<String>,
    /// Whether the next message continues an existing conversation.
    resuming: bool,
}

#[tauri::command]
fn agent_state(app: AppHandle, shared: State<Shared>) -> AgentState {
    AgentState {
        project: app.state::<agent::Project>().current().as_deref().map(agent::display_path),
        cli: shared.settings.lock().unwrap().agent_cli.clone(),
        resuming: app.state::<agent::Session>().current().is_some(),
    }
}

/// Remembers which CLI the chat runs, so the choice survives a restart. `None`
/// is a real value: it means the user has not chosen one yet.
#[tauri::command]
fn agent_set_cli(app: AppHandle, cli: Option<String>) {
    remember(&app, |s| s.agent_cli = cli);
}

/// What `/` can reach right now — the user's own commands, the project's, and
/// their skills.
#[tauri::command]
fn agent_commands(app: AppHandle) -> Vec<agent::SlashCommand> {
    agent::slash_commands(&app.state::<agent::Project>())
}

/// Attaches the folder the agent runs in. Nothing runs until one is chosen.
#[tauri::command]
fn attach_project(app: AppHandle, path: String) -> Result<String, String> {
    let name = app.state::<agent::Project>().attach(&path)?;
    // A new project is a new conversation: resuming the old session would run
    // it in the wrong folder.
    app.state::<agent::Session>().reset();
    log::line(format!("agent project attached: {name}"));
    let stored = name.clone();
    remember(&app, |s| {
        s.project_root = Some(stored);
        s.agent_session = None;
    });
    Ok(name)
}

#[tauri::command]
fn detach_project(app: AppHandle) {
    app.state::<agent::Project>().detach();
    app.state::<agent::Session>().reset();
    log::line("agent project detached");
    remember(&app, |s| {
        s.project_root = None;
        s.agent_session = None;
    });
}

/// Set while a folder picker is on screen. Without it a second click on the
/// chip put up a second dialog — the first one does not disable the chip,
/// because the chip lives in the webview and the dialog is a native window.
static PICKING: AtomicBool = AtomicBool::new(false);

/// Clears `PICKING` however the command ends, a dropped future included: a
/// flag left set would mean no picker for the rest of the run.
struct PickingGuard;

impl Drop for PickingGuard {
    fn drop(&mut self) {
        PICKING.store(false, Ordering::SeqCst);
    }
}

/// The folder picker, opened from Rust so the webview never handles a path it
/// did not get from the user. `win` owns the modal, so each caller passes the
/// window the dialog should belong to.
///
/// The dialog is modal and stays up for as long as the user wants it to.
/// Awaiting it on a runtime worker would park that worker for minutes, and the
/// hook pipe server and the agent turn share the same runtime — so it goes to
/// the blocking pool instead.
async fn choose_folder(win: tauri::WebviewWindow) -> Option<String> {
    if PICKING.swap(true, Ordering::SeqCst) {
        return None;
    }
    let _guard = PickingGuard;
    tauri::async_runtime::spawn_blocking(move || platform::pick_folder(&win))
        .await
        .ok()
        .flatten()
}

/// The window a dialog opened from the settings window should belong to.
fn settings_or_island(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("settings").or_else(|| island::window(app))
}

#[tauri::command]
async fn pick_project(app: AppHandle) -> Option<String> {
    choose_folder(island::window(&app)?).await
}

/// One agent turn through the chosen CLI. Its tool calls come back to the
/// island as ordinary hook events, and its permission card is the one Claude
/// Code sessions already use.
#[tauri::command]
async fn agent_send(app: AppHandle, cli: String, prompt: String) -> Result<String, String> {
    let before = app.state::<agent::Session>().current();
    // Each piece of the reply and each tool reached for goes straight to the
    // island, so the chat fills in as the agent works instead of sitting on
    // three dots until the whole answer is ready.
    let emitter = app.clone();
    let on = move |turn: agent::Turn| {
        let _ = emitter.emit("agent-turn", turn);
    };
    let settings = shared_settings(&app);

    // Nothing attached, but a default folder set: the chat runs there. Attached
    // rather than used for this turn alone, so the chip says where it is
    // running — a turn in a folder the user cannot see is worse than none.
    if app.state::<agent::Project>().current().is_none() {
        if let Some(folder) =
            agent::folder_for_turn(None, settings.default_chat_folder.as_deref())
        {
            match app.state::<agent::Project>().attach(&folder.to_string_lossy()) {
                Ok(name) => {
                    log::line(format!("agent project from the default folder: {name}"));
                    let stored = name.clone();
                    remember(&app, |s| s.project_root = Some(stored));
                    let _ = app.emit("agent-folder", name);
                }
                Err(err) => log::line(format!("default chat folder unusable: {err}")),
            }
        }
    }

    let knowledge = {
        let found = vault::resolve(settings.vault_path.as_deref());
        agent::Knowledge { briefing: vault::briefing(found.as_deref()), vault: found }
    };
    let result = {
        let project = app.state::<agent::Project>();
        let session = app.state::<agent::Session>();
        let cancel = app.state::<agent::Cancel>();
        agent::send(&project, &session, &cancel, &cli, prompt, &knowledge, &on).await
    };
    // The id is minted inside the first turn, and a resume that failed clears
    // it. Either way, what the next boot should continue has just changed.
    let after = app.state::<agent::Session>().current();
    if after != before {
        remember(&app, |s| s.agent_session = after);
    }
    result
}

// ── The conversation, kept across restarts ───────────────────────────────────

/// The last stretch of the chat, so the island comes back showing the
/// conversation whose CLI session it is about to resume.
#[tauri::command]
fn chat_load() -> Vec<transcript::Message> {
    transcript::load()
}

#[tauri::command]
fn chat_keep(messages: Vec<transcript::Message>) {
    transcript::save(&messages);
}

/// A new conversation: the CLI session and the transcript go together, or the
/// island would show one conversation while the CLI resumed another.
#[tauri::command]
fn chat_forget(app: AppHandle) {
    app.state::<agent::Session>().reset();
    transcript::clear();
    remember(&app, |s| s.agent_session = None);
}

// ── Disk, memory and the broom ────────────────────────────────────────────────

/// What the System tab shows. Asked for on a timer while the tab is open and
/// never otherwise, so a tab nobody has open costs nothing.
#[tauri::command]
fn system_stats() -> system::Stats {
    system::stats()
}

/// What cleaning the named targets would remove. Reads nothing, deletes
/// nothing: this is the preview the user is shown before anything happens.
#[tauri::command]
fn system_scan(ids: Vec<String>) -> Vec<system::Found> {
    system::scan(&ids)
}

/// Deletes what the preview said it would, and nothing else. Reached only from
/// a confirm button, and every removal is re-checked against the guard — a
/// file may have become a link to somewhere else since the scan.
#[tauri::command]
fn system_clean(ids: Vec<String>) -> Vec<system::Swept> {
    system::clean(&ids)
}

// ── The knowledge base ────────────────────────────────────────────────────────

/// The Obsidian vault the agent may read and write, and where it came from.
#[tauri::command]
fn vault_state(app: AppHandle) -> vault::VaultInfo {
    vault::info(shared_settings(&app).vault_path.as_deref())
}

/// Chooses the vault by hand, for when Obsidian's own list has none — it is
/// not installed, or the notes live somewhere it has never been pointed at.
#[tauri::command]
async fn pick_vault(app: AppHandle) -> Option<String> {
    let picked = choose_folder(settings_or_island(&app)?).await?;
    let stored = picked.clone();
    remember(&app, |s| s.vault_path = Some(stored));
    log::line(format!("vault chosen: {picked}"));
    Some(picked)
}

/// Goes back to whatever Obsidian itself has open.
#[tauri::command]
fn forget_vault(app: AppHandle) {
    remember(&app, |s| s.vault_path = None);
}

// ── The chat's default folder ─────────────────────────────────────────────────

/// Where the chat runs when nothing has been attached, and whether it is still
/// there. Kept apart from the plain setting because "set but missing" is a
/// state the settings window has to be able to say out loud.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderState {
    /// Empty when none is set.
    path: String,
    /// False when it is set but no longer a folder.
    exists: bool,
}

#[tauri::command]
fn chat_folder_state(app: AppHandle) -> FolderState {
    let path = shared_settings(&app).default_chat_folder.unwrap_or_default();
    let exists = !path.is_empty() && std::path::Path::new(&path).is_dir();
    FolderState { path, exists }
}

#[tauri::command]
async fn pick_chat_folder(app: AppHandle) -> Option<String> {
    let picked = choose_folder(settings_or_island(&app)?).await?;
    let stored = picked.clone();
    remember(&app, |s| s.default_chat_folder = Some(stored));
    log::line(format!("default chat folder: {picked}"));
    Some(picked)
}

#[tauri::command]
fn forget_chat_folder(app: AppHandle) {
    remember(&app, |s| s.default_chat_folder = None);
}

/// Stops the turn in flight. False when there was nothing to stop — the reply
/// landed between the click and this call.
#[tauri::command]
fn agent_cancel(app: AppHandle) -> bool {
    app.state::<agent::Cancel>().stop()
}

/// Starts a fresh conversation with the CLI, leaving the project attached.
#[tauri::command]
fn agent_reset(app: AppHandle) {
    app.state::<agent::Session>().reset();
    remember(&app, |s| s.agent_session = None);
}

/// One image from the inbox, as a data URI. Refused for anything outside it.
#[tauri::command]
fn image_preview(path: String) -> Result<String, String> {
    files::preview(&path)
}

/// An image pasted from the clipboard, which is the one case where the webview
/// hands over bytes rather than naming a file it was given.
#[tauri::command]
fn paste_image(media: String, bytes: Vec<u8>) -> Result<DroppedFile, String> {
    files::ingest_bytes(&media, &bytes)
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_clear(key: String) -> Result<(), String> {
    secrets::clear(&key)
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Settings — Coucou")
        .inner_size(560.0, 680.0)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

pub fn run() {
    platform::prepare_environment();
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(agent::Project::default())
        .manage(agent::Session::default())
        .manage(agent::Cancel::default())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            open_url,
            open_in_vscode,
            quit_app,
            hooks_status,
            hooks_preview,
            hooks_apply,
            approval_decision,
            approval_ack,
            approval_decline,
            log_line,
            agent_clis,
            agent_state,
            agent_set_cli,
            agent_commands,
            attach_project,
            detach_project,
            pick_project,
            agent_send,
            agent_cancel,
            system_stats,
            system_scan,
            system_clean,
            chat_load,
            chat_keep,
            chat_forget,
            vault_state,
            pick_vault,
            forget_vault,
            chat_folder_state,
            pick_chat_folder,
            forget_chat_folder,
            agent_reset,
            ingest_file,
            image_preview,
            paste_image,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            open_n8n,
            open_settings_window,
            set_paused,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);

            if let Some(win) = island::window(&handle) {
                platform::make_non_activating(&win);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Coucou {} started ---", env!("CARGO_PKG_VERSION")));
            reconcile_autostart(&handle, loaded.autostart);
            restore_agent(&handle, &loaded);
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Coucou");
}
