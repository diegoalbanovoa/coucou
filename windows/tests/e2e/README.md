# Folder-picker E2E

`platform::pick_folder()` shows a modal `IFileOpenDialog`. Nothing in
`cargo test` can drive a modal dialog, so the function shipped unexecuted.
This suite executes it.

The island itself is a WebView2 surface, which UI Automation cannot read into,
so these tests deliberately do **not** click the chat's "Attach project…"
chip. They call the Rust function directly through `#[ignore]`d tests in
`platform::windows::picker_e2e`, and drive the native dialog that comes up
with pywinauto. What that covers is the part that was actually unproven: the
COM apartment, the dialog options, whether the dialog is *visible*, and the
`SIGDN_FILESYSPATH` round trip.

## Run

```
pip install -r requirements.txt
cd windows/tests/e2e && pytest -v
```

It takes over the mouse and keyboard for a few seconds — it is driving a real
dialog on the real desktop. Don't type while it runs.

`cargo test` is unaffected: every Rust test these drive is `#[ignore]`d.

## Why no CI job

pywinauto needs an interactive desktop session. `windows-latest` has one, but
a dialog test that depends on foreground-window rules is the kind of thing
that goes flaky the moment the runner image changes. `conftest.py` bails out
under `CI` unless `E2E_HAS_DESKTOP=1` is set, so it is opt-in rather than a
permanent amber light.
