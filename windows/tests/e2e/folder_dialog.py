"""Drives the Windows shell folder picker from outside the process.

`platform::pick_folder()` shows an `IFileOpenDialog` with `FOS_PICKFOLDERS`.
That dialog is a native Win32 window, so it can be driven from here even
though the island that opens it is a WebView2 surface UIA cannot read into.

Everything here is locale independent: nothing matches on a caption or a
button label, because this machine's Windows is not necessarily in English.
The dialog is found by window class, and its parts by the control ids the
shell has used since the dialog was introduced.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import time

from pywinauto import Desktop
import pywinauto.keyboard as keyboard

# The common-dialog window class, and the control ids inside it. All four are
# stable Win32 contract values, unlike any visible string.
DIALOG_CLASS = "#32770"
# 1152 is the folder picker's "Folder:" edit. (1148, the file-name edit, is the
# *file* dialog's — it does not exist here.)
PATH_EDIT_ID = "1152"
CONFIRM_BUTTON_ID = "1"
CANCEL_BUTTON_ID = "2"

_user32 = ctypes.windll.user32


class DialogNotFound(RuntimeError):
    pass


def _handles(pid: int, class_name: str) -> list[int]:
    """Visible top-level windows of `pid` with this class, topmost first.

    `EnumWindows` rather than pywinauto's own search: the picker is *owned* by
    the island, and UIA then reports it under its owner instead of as a child
    of the desktop root, so `Desktop.windows(process=...)` does not list it.
    Win32 still enumerates it as the top-level window it is.
    """
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    found: list[int] = []

    def visit(hwnd, _lparam):
        owner = wt.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value != pid or not _user32.IsWindowVisible(hwnd):
            return True
        cls = ctypes.create_unicode_buffer(256)
        _user32.GetClassNameW(hwnd, cls, 256)
        if cls.value == class_name:
            found.append(hwnd)
        return True

    _user32.EnumWindows(callback_type(visit), 0)
    return found


def wait_for_dialog(pid: int, timeout: float = 20.0):
    """The folder picker owned by `pid`, once it is on screen.

    Polls rather than waiting on a UIA event: the dialog is created on a thread
    Coucou spawns for it, and UIA window-open events for a window that is not
    in the foreground arrive late often enough to be a worse signal.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        handles = _handles(pid, DIALOG_CLASS)
        if handles:
            dialog = Desktop(backend="uia").window(handle=handles[0])
            dialog.wait("visible", timeout=10)
            return dialog
        time.sleep(0.25)
    raise DialogNotFound(f"no {DIALOG_CLASS} window for pid {pid} within {timeout}s")


def choose(dialog, path: str) -> None:
    """Puts `path` in the dialog's Folder: box and confirms it.

    Typing the path beats clicking through the tree view: it needs no
    localised label, no scrolling, and it exercises the part actually under
    test — what `GetDisplayName(SIGDN_FILESYSPATH)` hands back.
    """
    dialog.set_focus()
    edit = dialog.child_window(auto_id=PATH_EDIT_ID, control_type="Edit")
    edit.wait("visible enabled", timeout=10)
    control = edit.wrapper_object()
    try:
        control.set_edit_text(path)
    except Exception:
        # Some shell builds leave the Value pattern read-only on this edit.
        control.click_input()
        keyboard.send_keys("^a{BACKSPACE}")
        keyboard.send_keys(path, with_spaces=True, pause=0.01)
    dialog.child_window(auto_id=CONFIRM_BUTTON_ID, control_type="Button").click_input()


def cancel(dialog) -> None:
    """Dismisses the dialog the way a user who changed their mind would."""
    dialog.set_focus()
    dialog.child_window(auto_id=CANCEL_BUTTON_ID, control_type="Button").click_input()


def wait_for_close(dialog, timeout: float = 10.0) -> None:
    """Blocks until the dialog is gone.

    Asked of Win32, not UIA: a dialog that has already been destroyed makes
    `ElementFromHandle` raise, so "it closed" and "the check failed" would be
    the same COM error.
    """
    handle = dialog.handle
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _user32.IsWindow(handle) or not _user32.IsWindowVisible(handle):
            return
        time.sleep(0.1)
    raise TimeoutError(f"the folder dialog ({handle}) was still up after {timeout}s")


def z_order(pid: int) -> list[tuple[str, str]]:
    """This process's visible top-level windows, topmost first.

    `EnumWindows` walks the z-order from the top down, which is the only thing
    that settles the question this suite exists to answer: the island is
    `WS_EX_TOPMOST`, so a dialog *below* it in this list is a dialog the island
    paints over — visible to UIA, invisible to the user.

    Foreground is not usable for that: whether a new window gets the
    foreground depends on which process delivered the last input event, and in
    a test that was the launcher.
    """
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    found: list[tuple[str, str]] = []

    def visit(hwnd, _lparam):
        owner = wt.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value != pid or not _user32.IsWindowVisible(hwnd):
            return True
        cls = ctypes.create_unicode_buffer(256)
        _user32.GetClassNameW(hwnd, cls, 256)
        title = ctypes.create_unicode_buffer(256)
        _user32.GetWindowTextW(hwnd, title, 256)
        found.append((cls.value, title.value))
        return True

    _user32.EnumWindows(callback_type(visit), 0)
    return found
