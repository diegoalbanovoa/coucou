//! Windows: Win32 for the island window and the cursor, %APPDATA% for files.
//!
//! Exports the same names as `platform/linux.rs`; see `platform/mod.rs`. The
//! island is a topmost, non-activating tool window: click-through and focus are
//! driven by extended window styles and the 60 Hz cursor poll, not by input
//! regions. Native dialogs (folder and file pickers) run on their own thread
//! with their own COM apartment and are owned by the island so they appear above
//! it. Most Win32 calls here are `unsafe` FFI; failures degrade to `None`,
//! `false`, empty or zero rather than panicking.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager, WebviewWindow};

use ::windows::core::{BOOL, PWSTR};
use ::windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, HWND, LPARAM, LocalFree, POINT, RECT};
use ::windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use ::windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use ::windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use ::windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use ::windows::Win32::System::Ole::RevokeDragDrop;
use ::windows::Win32::UI::Shell::{
    FileOpenDialog, IFileOpenDialog, IShellItemArray, FOS_ALLOWMULTISELECT, FOS_FORCEFILESYSTEM,
    FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
};
use ::windows::Win32::System::SystemInformation::GetLocalTime;
use ::windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use ::windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetClassNameW, GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW,
    GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use super::LocalTime;
use crate::island::WINDOW_LABEL;
use crate::log;

/// File name of the Claude Code relay.
pub const HOOK_EXE: &str = "coucou-hook.exe";

/// Environment variable holding the home directory.
pub const HOME_VAR: &str = "USERPROFILE";

/// Keeps spawned helpers from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Files ─────────────────────────────────────────────────────────────────────

/// %APPDATA%\Coucou — preferences.
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Coucou")
}

/// Obsidian's own settings, which hold its list of vaults (`%APPDATA%\obsidian`).
pub fn obsidian_config() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| super::home_dir().join("AppData").join("Roaming"))
        .join("obsidian")
        .join("obsidian.json")
}

/// %LOCALAPPDATA%\Coucou -- where coucou-hook.exe, the inbox and the log live.
pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Coucou")
}

/// %APPDATA% and %LOCALAPPDATA% are already private to the user.
pub fn ensure_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Nothing to set up before the webview starts.
pub fn prepare_environment() {}

/// Current local wall-clock time from `GetLocalTime`.
pub fn local_time() -> LocalTime {
    let t = unsafe { GetLocalTime() };
    LocalTime {
        year: t.wYear.into(),
        month: t.wMonth.into(),
        day: t.wDay.into(),
        hour: t.wHour.into(),
        minute: t.wMinute.into(),
        second: t.wSecond.into(),
    }
}

/// The Windows UI language, as a BCP-47 tag like "es-CO" or "en-US" — enough
/// for `i18n::Locale::resolve` to read the first two letters off of. `None`
/// on the (essentially theoretical) chance the call fails.
pub fn system_locale() -> Option<String> {
    use ::windows::Win32::Globalization::GetUserDefaultLocaleName;

    let mut buf = [0u16; 85]; // LOCALE_NAME_MAX_LENGTH
    let len = unsafe { GetUserDefaultLocaleName(&mut buf) };
    if len <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..(len as usize - 1)]))
}

// ── Processes ─────────────────────────────────────────────────────────────────

/// Spawned helpers must never flash a console window.
pub fn no_console(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

/// Opens `url` in the default browser via `rundll32 url.dll,FileProtocolHandler`,
/// without a console flash. Fire and forget: a failed spawn is ignored.
pub fn open_url(url: &str) {
    let _ = no_console(Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url]))
        .spawn();
}

/// Opens a folder in Explorer. Fire and forget.
pub fn reveal_folder(path: &str) {
    let _ = Command::new("explorer").arg(path).spawn();
}

/// Our own `where`: walks %PATH% against %PATHEXT%, no shell involved.
/// Rust quotes arguments correctly for `.cmd`/`.bat` targets since 1.77, so
/// spawning `code.cmd` directly is safe.
pub fn find_on_path(stem: &str) -> Option<PathBuf> {
    let dirs = std::env::var_os("PATH")?;
    std::env::split_paths(&dirs).find_map(|dir| find_in(&dir, stem))
}

/// `stem` as an executable inside `dir`, whatever suffix it carries here.
pub fn find_in(dir: &Path, stem: &str) -> Option<PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    for ext in exts.split(';').filter(|e| !e.is_empty()) {
        let candidate = dir.join(format!("{stem}{}", ext.to_lowercase()));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Where the tools that install agent CLIs actually put them.
///
/// PATH alone misses too much here. An npm global, a Volta or Bun or pnpm
/// shim, a vendor's own installer — each writes to its own folder and adds it
/// to the PATH of the shell the user installed from. Coucou is started by the
/// session rather than by a shell, so it often sees neither.
pub fn extra_bin_dirs() -> Vec<PathBuf> {
    let home = super::home_dir();
    let mut dirs = vec![
        // Where the Claude Code installer puts `claude`.
        home.join(".local").join("bin"),
        home.join(".bun").join("bin"),
        home.join(".cargo").join("bin"),
    ];
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        dirs.push(appdata.join("npm"));
        // nvm keeps one folder per Node version, and the global installs of
        // whichever is current live inside it.
        if let Ok(entries) = std::fs::read_dir(appdata.join("nvm")) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    dirs.push(entry.path());
                }
            }
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        dirs.push(local.join("pnpm"));
        dirs.push(local.join("Volta").join("bin"));
        dirs.push(local.join("Yarn").join("bin"));
        dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
    }

    let mut kept: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        if dir.is_dir() && !kept.contains(&dir) {
            kept.push(dir);
        }
    }
    kept
}

// ── Who we are ────────────────────────────────────────────────────────────────
//
// Named pipes share one machine-wide namespace, so the SID in the name is what
// keeps two accounts on the same machine from ever meeting on `coucou-*`.
// coucou-hook computes the same string (hook/src/win.rs) and additionally checks
// that the process serving the pipe really is us.

/// The SID of the account this process runs as, as `S-1-5-21-…`.
pub fn current_user_sid() -> Option<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;

        // First call sizes the buffer, second fills it.
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            let _ = CloseHandle(token);
            return None;
        }
        let mut buf = vec![0u8; needed as usize];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr().cast()),
            needed,
            &mut needed,
        )
        .is_ok();
        let _ = CloseHandle(token);
        if !ok {
            return None;
        }

        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
        let sid = text.to_string().ok();
        let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
        sid
    }
}

// ── Cursor ────────────────────────────────────────────────────────────────────

/// The 60 Hz poll reads the cursor and flips click-through from it.
pub const CURSOR_POLL: bool = true;

/// Cursor position in physical screen pixels.
pub fn cursor_physical() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

/// True while the left mouse button is held — the only signal we get that a
/// drag might be in flight before it reaches the window.
pub fn left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

// ── Island window ─────────────────────────────────────────────────────────────

/// The native handle of `win`, or `None` if it has no window yet (null handle).
fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
    let raw = win.hwnd().ok()?.0 as isize;
    if raw == 0 {
        return None;
    }
    Some(HWND(raw as *mut _))
}

/// Bottom edge of the work area (physical px, screen-relative) of whichever
/// monitor the island window is nearest — the taskbar excluded, unlike a
/// monitor's full `size()` (all `tao`/`tauri` expose). This is what keeps the
/// expanded chat from being clipped by the panel window's own fixed height:
/// see `island::screen_info`, which turns this into the logical ceiling
/// `core/layout.ts`'s `chatPromptHeight` clamps against.
pub fn work_area_bottom(win: &WebviewWindow) -> Option<i32> {
    let hwnd = hwnd_of(win)?;
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    let ok = unsafe { GetMonitorInfoW(monitor, &mut info) };
    if !ok.as_bool() {
        return None;
    }
    let RECT { bottom, .. } = info.rcWork;
    Some(bottom)
}

/// Lets dropped files reach the app again.
///
/// wry installs its drop target by walking the webview's child windows **once**,
/// when the webview is created. WebView2 creates `Chrome_RenderWidgetHostHWND`
/// later and registers its own target on it; being the innermost window, that one
/// wins, and since the page has no HTML5 drop handler it refuses everything — the
/// "no drop" cursor, with nothing reaching Tauri. Revoking it makes OLE fall
/// through to the target wry registered on the parent widget, which is the one
/// that feeds Tauri's drag events.
///
/// Cheap and idempotent, so it is simply re-run whenever a drag might be starting.
pub fn unblock_webview_drops(app: &AppHandle) {
    for label in [WINDOW_LABEL, "settings"] {
        let Some(win) = app.get_webview_window(label) else { continue };
        let Some(hwnd) = hwnd_of(&win) else { continue };
        unsafe {
            let _ = EnumChildWindows(Some(hwnd), Some(revoke_render_widget), LPARAM(0));
        }
    }
}

/// `EnumChildWindows` callback: revokes the OLE drop target of WebView2's
/// `Chrome_RenderWidgetHostHWND`, leaving wry's parent target to receive drops.
/// Always returns true so the enumeration continues.
unsafe extern "system" fn revoke_render_widget(hwnd: HWND, _: LPARAM) -> BOOL {
    let mut name = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut name) };
    if len > 0 {
        let class = String::from_utf16_lossy(&name[..len as usize]);
        if class == "Chrome_RenderWidgetHostHWND" {
            let _ = unsafe { RevokeDragDrop(hwnd) };
        }
    }
    true.into()
}

/// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the
/// island out of Alt-Tab.
pub fn make_non_activating(win: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Temporarily allow activation so a text field inside the island can be typed in.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = if activating {
            ex & !(WS_EX_NOACTIVATE.0 as isize)
        } else {
            ex | WS_EX_NOACTIVATE.0 as isize
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Click-through here is the poll's WS_EX_TRANSPARENT toggle, not a region.
pub fn set_input_region(_win: &WebviewWindow, _rect: Option<(f64, f64, f64, f64)>) {}

// ── Folder picker ─────────────────────────────────────────────────────────────

/// The shell's folder picker, for attaching a project to the chat.
///
/// Owned by the island. That is the whole difference between this working and
/// not: the island is `WS_EX_TOPMOST`, so an ownerless dialog comes up
/// *underneath* it and behind whatever else is on screen — a picker nobody can
/// see, and a click that lands on another window. An owned dialog joins the
/// island's z-order band and is shown above it, and the island is disabled
/// while it is up, which is what modal is supposed to mean.
pub fn pick_folder(win: &WebviewWindow, title: &str) -> Option<String> {
    pick_folder_owned(hwnd_of(win).map(|h| h.0 as isize), title.to_string())
}

/// The picker as the OS sees it, addressed by raw owner handle.
///
/// Split out from `pick_folder` for two reasons: `HWND` is not `Send`, so the
/// handle has to cross into the dialog thread as an integer, and the tests
/// need to open the picker without a `WebviewWindow` to get a handle from.
fn pick_folder_owned(owner: Option<isize>, title: String) -> Option<String> {
    // Its own thread, with its own COM apartment. The dialog runs a modal
    // message loop on whichever thread shows it; on a shared one that is
    // Mochi's thread or a runtime worker, and the apartment mode of a pooled
    // thread is not ours to assume.
    std::thread::spawn(move || unsafe {
        // Ignore an already-initialised apartment; only an outright failure
        // means there is nowhere to show a dialog.
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let picked = show_folder_dialog(owner.map(|h| HWND(h as *mut _)), &title);
        if init.is_ok() {
            CoUninitialize();
        }
        picked
    })
    .join()
    .ok()
    .flatten()
}

/// What the shell returns when the user closed the dialog without choosing:
/// `HRESULT_FROM_WIN32(ERROR_CANCELLED)`. Worth naming, because it is the one
/// error here that is not a problem.
const CANCELLED: ::windows::core::HRESULT = ::windows::core::HRESULT(0x8007_04C7u32 as i32);

/// Runs the folder dialog. Returns `None` on cancel and, after logging, on a real
/// failure. Must be called on a thread with an initialised COM apartment.
unsafe fn show_folder_dialog(owner: Option<HWND>, title: &str) -> Option<String> {
    match open_folder_dialog(owner, title) {
        Ok(path) => path,
        // Changing your mind is not a failure and says nothing worth logging.
        Err(err) if err.code() == CANCELLED => None,
        // Anything else is a real failure — no interactive desktop, COM
        // refusing to start, a broken shell. Silently returning `None` here
        // made those look exactly like a cancel, which is how an unopenable
        // picker could go unnoticed.
        Err(err) => {
            log::line(format!("folder picker failed: {err}"));
            None
        }
    }
}

/// Shows the shell's folder picker owned by `owner` and returns the chosen file
/// system path. A cancel surfaces as the `CANCELLED` error.
unsafe fn open_folder_dialog(owner: Option<HWND>, title: &str) -> ::windows::core::Result<Option<String>> {
    let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
    let options = dialog.GetOptions()?;
    dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM)?;
    dialog.SetTitle(&::windows::core::HSTRING::from(title))?;
    dialog.Show(owner)?;
    let item = dialog.GetResult()?;
    let wide = item.GetDisplayName(SIGDN_FILESYSPATH)?;
    let path = wide.to_string().ok();
    CoTaskMemFree(Some(wide.0 as *const _));
    Ok(path)
}

/// The paperclip's native picker (plan-v2.md § 5.3) — any kind of file, any
/// number of them. Validation (blocked extensions, size, count) is Rust's
/// `files::ingest` and views/chat.ts's own caps, same as a drop; this only
/// ever hands back paths. An empty `Vec` means cancelled, same as `None`
/// would for a single pick — there is nothing here a caller needs to tell
/// apart from "nothing chosen".
pub fn pick_files(win: &WebviewWindow, title: &str) -> Vec<String> {
    pick_files_owned(hwnd_of(win).map(|h| h.0 as isize), title.to_string())
}

/// Runs the multi-file picker on its own thread/apartment (see
/// `pick_folder_owned`); an empty list for cancel or failure.
fn pick_files_owned(owner: Option<isize>, title: String) -> Vec<String> {
    // Same reasoning as pick_folder_owned: its own thread and COM apartment,
    // since the dialog runs a modal message loop on whichever thread shows it.
    std::thread::spawn(move || unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let picked = show_files_dialog(owner.map(|h| HWND(h as *mut _)), &title);
        if init.is_ok() {
            CoUninitialize();
        }
        picked
    })
    .join()
    .unwrap_or_default()
}

/// Runs the file dialog. Cancel gives an empty list; a real failure is logged and
/// also gives an empty list.
unsafe fn show_files_dialog(owner: Option<HWND>, title: &str) -> Vec<String> {
    match open_files_dialog(owner, title) {
        Ok(paths) => paths,
        Err(err) if err.code() == CANCELLED => Vec::new(),
        Err(err) => {
            log::line(format!("file picker failed: {err}"));
            Vec::new()
        }
    }
}

/// Shows the shell's multi-select file picker titled `title` and returns the
/// chosen paths. A cancel surfaces as the `CANCELLED` error.
unsafe fn open_files_dialog(owner: Option<HWND>, title: &str) -> ::windows::core::Result<Vec<String>> {
    let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
    let options = dialog.GetOptions()?;
    dialog.SetOptions(options | FOS_ALLOWMULTISELECT | FOS_FORCEFILESYSTEM)?;
    // plan-v2.md § 5.3 asks for this one's title specifically — see
    // i18n.rs's own note on why the folder picker next to this does not.
    dialog.SetTitle(&::windows::core::HSTRING::from(title))?;
    dialog.Show(owner)?;
    let items: IShellItemArray = dialog.GetResults()?;
    let count = items.GetCount()?;
    let mut paths = Vec::with_capacity(count as usize);
    for i in 0..count {
        let item = items.GetItemAt(i)?;
        let wide = item.GetDisplayName(SIGDN_FILESYSPATH)?;
        if let Ok(path) = wide.to_string() {
            paths.push(path);
        }
        CoTaskMemFree(Some(wide.0 as *const _));
    }
    Ok(paths)
}

// ── Disk, memory and the recycle bin ─────────────────────────────────────────

/// Where this user's temp files are. `GetTempPath` is the same answer, but
/// `std` already read the environment for us.
pub fn temp_dir() -> Option<PathBuf> {
    let dir = std::env::temp_dir();
    dir.is_dir().then_some(dir)
}

/// Where npm keeps its cache on Windows (`%LOCALAPPDATA%\npm-cache`).
pub fn npm_cache_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| super::home_dir().join("AppData").join("Local"))
        .join("npm-cache")
}

/// Where pip keeps its cache on Windows (`%LOCALAPPDATA%\pip\Cache`).
pub fn pip_cache_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| super::home_dir().join("AppData").join("Local"))
        .join("pip")
        .join("Cache")
}

/// Every fixed drive, with the room left on it.
///
/// Removable and network drives are left out: a card reader with nothing in it
/// answers slowly or not at all, and a disconnected share answers after a
/// timeout nobody opening a tab wants to wait through.
pub fn drives() -> Vec<super::Drive> {
    use ::windows::core::PCWSTR;
    use ::windows::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives,
    };

    /// What `GetDriveTypeW` answers for a real disk. Written out rather than
    /// imported: the constant has moved between modules across versions of the
    /// windows crate, and the number has not moved since Windows 95.
    const DRIVE_FIXED: u32 = 3;

    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();

    for bit in 0..26u32 {
        if mask & (1 << bit) == 0 {
            continue;
        }
        let letter = (b'A' + bit as u8) as char;
        let root: Vec<u16> =
            format!("{letter}:\\").encode_utf16().chain(std::iter::once(0)).collect();
        let kind = unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) };
        if kind != DRIVE_FIXED {
            continue;
        }

        let mut free = 0u64;
        let mut total = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(PCWSTR(root.as_ptr()), None, Some(&mut total), Some(&mut free))
        };
        if ok.is_ok() && total > 0 {
            out.push(super::Drive { name: format!("{letter}:"), free, total });
        }
    }
    out
}

/// The share of CPU time spent outside idle since the last call, 0 to 100.
///
/// `GetSystemTimes` only ever gives a running total, so there is nothing to
/// report from one call alone — the first call of a run has no prior sample
/// to diff against and answers 0, which is fine for a value polled every
/// couple of seconds for as long as the tab is open.
pub fn cpu_percent() -> f32 {
    use ::windows::Win32::Foundation::FILETIME;
    use ::windows::Win32::System::Threading::GetSystemTimes;
    use std::sync::{Mutex, OnceLock};

    fn as_u64(ft: FILETIME) -> u64 {
        ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
    }

    let mut idle = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.is_err() {
        return 0.0;
    }
    // `lpKernelTime` already counts idle time, so the busy share is the total
    // minus idle, not kernel+user+idle.
    let idle = as_u64(idle);
    let total = as_u64(kernel) + as_u64(user);

    static LAST: OnceLock<Mutex<Option<(u64, u64)>>> = OnceLock::new();
    let mut last = LAST.get_or_init(|| Mutex::new(None)).lock().unwrap();
    let pct = match *last {
        Some((last_idle, last_total)) => {
            let d_total = total.saturating_sub(last_total);
            let d_idle = idle.saturating_sub(last_idle);
            if d_total == 0 { 0.0 } else { (d_total - d_idle) as f32 / d_total as f32 * 100.0 }
        }
        None => 0.0,
    };
    *last = Some((idle, total));
    pct.clamp(0.0, 100.0)
}

/// Memory in use and installed, in bytes.
pub fn memory() -> (u64, u64) {
    use ::windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    if unsafe { GlobalMemoryStatusEx(&mut status) }.is_err() {
        return (0, 0);
    }
    let total = status.ullTotalPhys;
    (total.saturating_sub(status.ullAvailPhys), total)
}

/// How much the recycle bin holds, as (items, bytes).
pub fn recycle_bin_size() -> Option<(u64, u64)> {
    use ::windows::core::PCWSTR;
    use ::windows::Win32::UI::Shell::{SHQueryRecycleBinW, SHQUERYRBINFO};

    let mut info =
        SHQUERYRBINFO { cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32, ..Default::default() };
    // A null path means every drive's bin at once, which is what the tab says.
    unsafe { SHQueryRecycleBinW(PCWSTR::null(), &mut info) }.ok()?;
    Some((info.i64NumItems as u64, info.i64Size as u64))
}

// ── Processes ─────────────────────────────────────────────────────────────────
//
// What the System tab needs is not a full process manager: it is "what is
// using the memory", which means a name and a working-set size per process,
// and a way to end one the user picked. Both are read through a Toolhelp
// snapshot rather than the newer `sysinfo`-style APIs, for the same reason
// the drive and memory readers above call Win32 directly: one more crate
// trades a known, small surface for one this file does not control.

/// Every running process, with enough to group it, show it, and later tell
/// whether a pid someone clicked "end" on is still the same process.
///
/// The memory figure is best-effort: a process this account cannot query —
/// another user's, or one elevated above it — is still listed, with `0`
/// rather than being dropped, so the list is not quietly missing the very
/// processes most likely to be using the memory. `start_time` and `ppid`
/// come from the same handle the memory query opens, so a process this
/// account cannot touch gets `0` for those too — `system.rs`'s pid-reuse
/// check treats an unreadable start time as never matching, which is the
/// safe direction for a check that exists to refuse an end request.
pub fn processes() -> Vec<super::RawProc> {
    use ::windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use ::windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use ::windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };

    let mut entry =
        PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut out = Vec::new();

    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
        loop {
            let end = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
            let pid = entry.th32ProcessID;
            let ppid = entry.th32ParentProcessID;

            if pid != 0 {
                let (memory, start_time) = unsafe {
                    OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid)
                }
                .map(|handle| {
                    let mut counters = PROCESS_MEMORY_COUNTERS {
                        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                        ..Default::default()
                    };
                    let got = unsafe { GetProcessMemoryInfo(handle, &mut counters, counters.cb) };
                    let memory = if got.is_ok() { counters.WorkingSetSize as u64 } else { 0 };

                    let (mut created, mut exited, mut kernel, mut user) = Default::default();
                    let start_time = if unsafe {
                        GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)
                    }
                    .is_ok()
                    {
                        ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64
                    } else {
                        0
                    };

                    unsafe { let _ = CloseHandle(handle); }
                    (memory, start_time)
                })
                .unwrap_or((0, 0));
                out.push(super::RawProc { pid, ppid, name, memory, start_time });
            }

            if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }
    unsafe { let _ = CloseHandle(snapshot); }
    out
}

/// Ends one process. `false` when it could not be opened for termination —
/// most often because it belongs to another account or is elevated above
/// this one, which this function treats as "no" rather than trying harder.
pub fn kill_process(pid: u32) -> bool {
    use ::windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    let Ok(handle) = (unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) }) else { return false };
    let ok = unsafe { TerminateProcess(handle, 1) }.is_ok();
    unsafe { let _ = CloseHandle(handle); }
    ok
}

/// Hands off to Windows' own Disk Cleanup rather than reimplementing it — the
/// one path in the System tab that needs administrator rights for some of
/// what it offers, which Coucou itself never asks for.
pub fn open_disk_cleanup() -> bool {
    let mut cmd = Command::new("cleanmgr.exe");
    no_console(&mut cmd);
    cmd.spawn().is_ok()
}

/// Empties it, with no confirmation of its own — the island already asked.
pub fn empty_recycle_bin() -> bool {
    use ::windows::core::PCWSTR;
    use ::windows::Win32::UI::Shell::{
        SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND,
    };

    unsafe {
        SHEmptyRecycleBinW(
            None,
            PCWSTR::null(),
            SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND,
        )
    }
    .is_ok()
}

// ── Folder picker, end to end ─────────────────────────────────────────────────

/// Tests that put a real dialog on screen.
///
/// Every one of these is `#[ignore]`d, so `cargo test` stays headless. They
/// exist to be driven from outside the process by `windows/tests/e2e`, which
/// finds the dialog through UI Automation and answers it — the only way to
/// cover `pick_folder`, since nothing inside a test harness can click a modal
/// window's buttons.
///
/// Run them the way that suite does, never by hand:
///   cd windows/tests/e2e && pytest -v
#[cfg(test)]
mod picker_e2e {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use ::windows::core::w;
    use ::windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, PeekMessageW, TranslateMessage,
        MSG, PM_REMOVE, WINDOW_EX_STYLE, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
    };

    /// A stand-in for the island: topmost, non-activating, out of Alt-Tab.
    ///
    /// The bug this guards against only exists against a window like this, so
    /// a test that opened an ownerless dialog on an empty desktop would pass
    /// while the real thing stayed invisible. "STATIC" is a class the system
    /// already registers, which is why there is no window proc here.
    ///
    /// It gets a thread of its own with a message pump, and that is not
    /// decoration. A modal dialog owned by a window on another thread sends
    /// messages to the owner's thread while it is being created; a thread that
    /// never pumps never answers them, and the dialog is never created at all
    /// — it hangs with nothing on screen. That is exactly what happens here if
    /// the pump below is removed. In Coucou the owner is the island, whose
    /// thread is the Tauri main loop and always pumps, which is also why
    /// `pick_project` hands the dialog to the blocking pool rather than
    /// holding a runtime worker that the main loop might be waiting on.
    struct FakeIsland {
        hwnd: isize,
        stop: Arc<AtomicBool>,
        pump: Option<std::thread::JoinHandle<()>>,
    }

    impl FakeIsland {
        fn new() -> Self {
            let (tx, rx) = std::sync::mpsc::channel();
            let stop = Arc::new(AtomicBool::new(false));
            let flag = stop.clone();
            let pump = std::thread::spawn(move || unsafe {
                let hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE(WS_EX_TOPMOST.0 | WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0),
                    w!("STATIC"),
                    w!("Coucou picker test"),
                    WS_POPUP | WS_VISIBLE,
                    300,
                    0,
                    720,
                    320,
                    None,
                    None,
                    None,
                    None,
                )
                .expect("the system STATIC class always creates");
                tx.send(hwnd.0 as isize).expect("the test is waiting for this");

                let mut msg = MSG::default();
                while !flag.load(Ordering::Relaxed) {
                    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                let _ = DestroyWindow(hwnd);
            });

            let hwnd = rx.recv().expect("the window thread always reports its handle");
            Self { hwnd, stop, pump: Some(pump) }
        }

        fn owner(&self) -> Option<isize> {
            Some(self.hwnd)
        }
    }

    impl Drop for FakeIsland {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(pump) = self.pump.take() {
                let _ = pump.join();
            }
        }
    }

    /// The happy path. The driver types a folder and confirms it; what the
    /// dialog handed back is printed for the driver to assert on, because the
    /// path it chose is not knowable from in here.
    #[test]
    #[ignore = "shows a modal dialog; driven by windows/tests/e2e"]
    fn pick_folder_returns_a_path() {
        let island = FakeIsland::new();
        let picked = pick_folder_owned(island.owner(), "Test folder".to_string());
        let path = picked.expect("the driver confirmed a folder, so there must be a path");
        assert!(
            std::path::Path::new(&path).is_dir(),
            "the picker returned something that is not a folder: {path}"
        );
        // SIGDN_FILESYSPATH, not a shell display name: no "This PC > …".
        assert!(!path.contains('>'), "not a filesystem path: {path}");
        println!("picked: {path}");
    }

    /// Escape is a no-op. `Show` reports cancellation as an error, and the
    /// point of this test is that it does not get logged or surfaced as one.
    #[test]
    #[ignore = "shows a modal dialog; driven by windows/tests/e2e"]
    fn pick_folder_cancels_cleanly() {
        let island = FakeIsland::new();
        assert!(pick_folder_owned(island.owner(), "Test folder".to_string()).is_none());
        println!("cancelled");
    }

    /// Twice in a row, on the same process. Each call sets up and tears down
    /// its own COM apartment; a `CoUninitialize` that did not pair with its
    /// `CoInitializeEx` would show up on the second call and nowhere else.
    #[test]
    #[ignore = "shows two modal dialogs; driven by windows/tests/e2e"]
    fn pick_folder_twice() {
        let island = FakeIsland::new();
        for _ in 0..2 {
            let path = pick_folder_owned(island.owner(), "Test folder".to_string()).expect("the driver confirmed a folder");
            println!("picked: {path}");
        }
    }
}
