// A note one window leaves for the Settings window: "open on this, ready".
//
// The island cannot show the hooks diff itself (that UI, with its backup path
// and confirm button, lives only in Settings), so its "Install hooks" button
// asks Settings to open on the Claude Code section with the diff already
// prepared. Both windows share one origin, hence one localStorage: a fresh
// Settings window reads the note when it boots, and one that is already open
// hears it through the `storage` event. Nothing is written to disk by this;
// the user still reads the diff and confirms there.

const KEY = "coucou.settings.intent";

/** What the island can ask Settings to do. */
export type SettingsIntent = "installHooks";

/** Leaves the note. Call before opening the Settings window. */
export function leaveSettingsIntent(intent: SettingsIntent): void {
  try {
    localStorage.setItem(KEY, intent);
  } catch {
    /* no storage: the button just opens Settings, as "Settings…" does */
  }
}

/** Reads and clears the note, so it is acted on exactly once. */
export function takeSettingsIntent(): SettingsIntent | null {
  try {
    const value = localStorage.getItem(KEY);
    if (value !== "installHooks") return null;
    localStorage.removeItem(KEY);
    return value;
  } catch {
    return null;
  }
}

/** Calls `onIntent` when another window leaves a note while this one is open. */
export function watchSettingsIntent(onIntent: (intent: SettingsIntent) => void): void {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY || e.newValue == null) return;
    const intent = takeSettingsIntent();
    if (intent) onIntent(intent);
  });
}
