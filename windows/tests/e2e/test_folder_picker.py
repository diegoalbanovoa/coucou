"""The folder picker, exercised for real.

`platform::pick_folder()` had never been executed before this file existed: it
is COM code on a thread of its own, and nothing in the unit tests can show a
modal dialog. These tests run it and drive the dialog that comes up.

Marked `#[ignore]` on the Rust side, so `cargo test` stays headless; this
suite is the only thing that asks for them.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

import folder_dialog

# A folder that exists on every Windows box and is not a shell namespace
# oddity, so `SIGDN_FILESYSPATH` has a real path to give back.
TARGET = Path(os.environ["USERPROFILE"]) / "Documents"


def _finish(proc, timeout: float = 30.0) -> tuple[int, str]:
    out = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            out.append(proc.stdout.read())
            return proc.returncode, "".join(out)
        time.sleep(0.2)
    proc.kill()
    pytest.fail("the Rust test never returned — pick_folder() is still blocked")


@pytest.mark.smoke
def test_dialog_opens_and_returns_the_chosen_folder(run_ignored):
    """The happy path: a dialog appears, a path is chosen, Rust gets it back."""
    proc = run_ignored("platform::windows::picker_e2e::pick_folder_returns_a_path")

    dialog = folder_dialog.wait_for_dialog(proc.pid)
    dialog.capture_as_image().save(str(Path(__file__).parent / "artifacts" / "dialog_open.png"))

    folder_dialog.choose(dialog, str(TARGET))
    folder_dialog.wait_for_close(dialog)

    code, output = _finish(proc)
    assert code == 0, f"Rust test failed:\n{output}"
    # The Rust side prints what the dialog handed it; this is the assertion
    # that the COM path — GetDisplayName + CoTaskMemFree — actually works.
    assert f"picked: {TARGET}" in output, output


@pytest.mark.smoke
def test_dialog_sits_above_the_island(run_ignored):
    """A dialog nobody can see is the bug this feature actually had.

    The Rust test puts up a stand-in island with the real island's styles —
    `WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` — and opens the
    picker owned by it. Owned, the dialog joins the island's topmost band and
    is drawn above it. Ownerless, which is how this shipped, the island is
    always-on-top and the dialog is not, so the island paints straight over
    it: a picker that exists, has focus, and cannot be seen.
    """
    proc = run_ignored("platform::windows::picker_e2e::pick_folder_returns_a_path")
    dialog = folder_dialog.wait_for_dialog(proc.pid)

    stack = folder_dialog.z_order(proc.pid)
    classes = [cls for cls, _ in stack]

    folder_dialog.cancel(dialog)
    _finish(proc)

    assert folder_dialog.DIALOG_CLASS in classes, f"no dialog in the z-order: {stack}"
    assert "Static" in classes, f"the stand-in island is gone: {stack}"
    # EnumWindows walks top down, so the dialog must come first.
    assert classes.index(folder_dialog.DIALOG_CLASS) < classes.index("Static"), (
        f"the island is above the folder dialog, so it would cover it: {stack}"
    )


def test_cancel_returns_nothing(run_ignored):
    """Escape is a no-op, not an error: nothing gets attached."""
    proc = run_ignored("platform::windows::picker_e2e::pick_folder_cancels_cleanly")

    dialog = folder_dialog.wait_for_dialog(proc.pid)
    folder_dialog.cancel(dialog)
    folder_dialog.wait_for_close(dialog)

    code, output = _finish(proc)
    assert code == 0, f"Rust test failed:\n{output}"
    assert "cancelled" in output, output


def test_picker_can_be_reopened(run_ignored):
    """Twice in a row, because the COM apartment is set up per call.

    A `CoUninitialize` that did not pair with its `CoInitializeEx` would show
    up here and nowhere else.
    """
    proc = run_ignored("platform::windows::picker_e2e::pick_folder_twice")

    for _ in range(2):
        dialog = folder_dialog.wait_for_dialog(proc.pid)
        folder_dialog.choose(dialog, str(TARGET))
        folder_dialog.wait_for_close(dialog)

    code, output = _finish(proc)
    assert code == 0, f"Rust test failed:\n{output}"
    assert output.count(f"picked: {TARGET}") == 2, output
