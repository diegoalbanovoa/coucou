// Dropped files are copied into %LOCALAPPDATA%\Coucou\inbox so the original is
// never touched and the copy survives the drag source going away.
// The inbox is swept of anything older than a week, as on macOS.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::settings;

const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub fn inbox_dir() -> PathBuf {
    settings::local_dir().join("inbox")
}

pub fn ingest(source: &str) -> Result<DroppedFile, String> {
    let src = Path::new(source);
    let meta = std::fs::metadata(src).map_err(|e| format!("cannot read {source}: {e}"))?;
    if meta.is_dir() {
        return Err("Folders can't be dropped yet.".into());
    }

    let dir = inbox_dir();
    crate::platform::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    let mut dest = dir.join(&name);
    if dest.exists() {
        let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = src.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
        for i in 2..1000 {
            let candidate = dir.join(format!("{stem} ({i}){ext}"));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
        }
    }

    std::fs::copy(src, &dest).map_err(|e| format!("cannot copy: {e}"))?;
    // CopyFileEx carries the source's timestamps across, so a file last edited
    // three years ago would arrive already older than the sweep window and be
    // deleted on the spot. The inbox ages from when *we* copied it.
    if let Ok(file) = std::fs::File::options().write(true).open(&dest) {
        let _ = file.set_modified(SystemTime::now());
    }
    sweep(&dir);

    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
    })
}

/// Drops anything copied here more than a week ago. `ingest` stamps every copy
/// with the time it landed, so this really is the age of the copy and not the
/// age of whatever the user happened to drag in.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(copied) = meta.modified() else { continue };
        if now.duration_since(copied).map(|age| age > KEEP_FOR).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let tmp = std::env::temp_dir().join(format!("coucou-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let first = ingest(source.to_str().unwrap()).unwrap();
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // A second drop of the same name must not clobber the first copy.
        std::fs::write(&source, b"second").unwrap();
        let second = ingest(source.to_str().unwrap()).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");

        // Folders are refused rather than silently ignored.
        assert!(ingest(tmp.to_str().unwrap()).is_err());

        // An ancient source must not arrive already older than the sweep window.
        let old_source = tmp.join("ancient.txt");
        std::fs::write(&old_source, b"old").unwrap();
        let long_ago = SystemTime::now() - KEEP_FOR - Duration::from_secs(60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        let aged = ingest(old_source.to_str().unwrap()).unwrap();
        assert!(
            Path::new(&aged.path).exists(),
            "a file copied just now was swept as if it were a week old"
        );
        let _ = std::fs::remove_file(&aged.path);

        let _ = std::fs::remove_file(&first.path);
        let _ = std::fs::remove_file(&second.path);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

// ── Images in the chat ───────────────────────────────────────────────────────

/// What may be attached to a message.
pub const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
/// How large a file may be and still be attachable.
///
/// Enforced here for a paste, where Coucou receives the bytes. A drop is
/// checked in views/chat.ts against the size `ingest` reports, because by then
/// the file has already been copied — mirrored deliberately, and this comment
/// is here so the two cannot drift unnoticed.
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// How large it may be and still be shown inline.
///
/// The preview crosses the IPC boundary as base64, which is a third larger
/// again than the file. A screenshot is a few hundred kilobytes; a photo
/// straight off a phone is not, and it gets a chip with no thumbnail rather
/// than fifteen megabytes of string.
pub const MAX_PREVIEW_BYTES: u64 = 4 * 1024 * 1024;
// How many may ride along on one message is the tray's business, and lives in
// views/chat.ts where it is enforced. A second copy here would be a number
// nothing checks, drifting from the one that does.

pub fn is_image(path: &Path) -> bool {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .map(|e| IMAGE_EXTS.contains(&e.as_str()))
        .unwrap_or(false)
}

fn media_type(path: &Path) -> &'static str {
    match path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default().as_str()
    {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/jpeg",
    }
}

/// True when `path` really is inside the inbox.
///
/// Both sides are canonicalised first, which is what makes this a boundary
/// rather than a string comparison: `..` is resolved, and a symlink or
/// junction pointing out of the inbox resolves to where it actually goes.
fn inside_inbox(path: &Path) -> bool {
    let inbox = match inbox_dir().canonicalize() {
        Ok(dir) => dir,
        Err(_) => return false,
    };
    match path.canonicalize() {
        Ok(real) => real.starts_with(&inbox),
        Err(_) => false,
    }
}

/// One image from the inbox, as a data URI the island can put in an `<img>`.
///
/// The webview asks by path, and the only paths it has are ones `ingest` gave
/// it — but it is asked to prove that anyway. A command that reads a file the
/// webview names is exactly the one worth being strict in.
pub fn preview(path: &str) -> Result<String, String> {
    let file = Path::new(path);
    if !inside_inbox(file) {
        return Err("That file is not in Coucou's inbox.".into());
    }
    if !is_image(file) {
        return Err("That is not an image Coucou shows.".into());
    }
    let size = std::fs::metadata(file).map_err(|e| e.to_string())?.len();
    if size > MAX_PREVIEW_BYTES {
        return Err("too large to show inline".into());
    }
    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    Ok(format!("data:{};base64,{}", media_type(file), base64(&bytes)))
}

/// Puts bytes from the clipboard into the inbox under a name of our choosing.
///
/// Pasting is the one way an image arrives without a path to copy from, so it
/// is the one case where the webview hands over content rather than naming a
/// file. The extension is taken from the media type and never from the name.
pub fn ingest_bytes(media: &str, bytes: &[u8]) -> Result<DroppedFile, String> {
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("That image is larger than 10 MB.".into());
    }
    let ext = match media {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => return Err("Coucou pastes PNG, JPEG, WebP and GIF.".into()),
    };

    let dir = inbox_dir();
    crate::platform::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Named for when it was pasted, because a clipboard image has no name and
    // "image.png" would collide with every other paste.
    let now = crate::platform::local_time();
    let stem = format!(
        "pasted-{:04}{:02}{:02}-{:02}{:02}{:02}",
        now.year, now.month, now.day, now.hour, now.minute, now.second
    );
    let mut dest = dir.join(format!("{stem}.{ext}"));
    for i in 2..1000 {
        if !dest.exists() {
            break;
        }
        dest = dir.join(format!("{stem} ({i}).{ext}"));
    }
    std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;

    Ok(DroppedFile {
        name: dest.file_name().unwrap_or_default().to_string_lossy().to_string(),
        path: dest.to_string_lossy().to_string(),
        size: bytes.len() as u64,
    })
}

/// Small standalone base64 encoder — not worth another dependency. Used for
/// image previews here, and for Stripe's basic auth in integrations.rs.
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod image_tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn only_the_image_kinds_coucou_shows_are_images() {
        for name in ["a.png", "a.PNG", "a.jpg", "a.jpeg", "a.webp", "a.gif"] {
            assert!(is_image(Path::new(name)), "{name} should be an image");
        }
        for name in ["a.svg", "a.bmp", "a.txt", "a.png.exe", "a", "a."] {
            assert!(!is_image(Path::new(name)), "{name} should not be");
        }
    }

    #[test]
    fn the_media_type_comes_from_the_extension_not_the_name() {
        assert_eq!(media_type(Path::new("a.png")), "image/png");
        assert_eq!(media_type(Path::new("a.webp")), "image/webp");
        assert_eq!(media_type(Path::new("a.gif")), "image/gif");
        assert_eq!(media_type(Path::new("a.jpeg")), "image/jpeg");
        assert_eq!(media_type(Path::new("image/png.jpg")), "image/jpeg");
    }

    #[test]
    fn a_preview_is_refused_for_anything_outside_the_inbox() {
        // The webview only ever has paths `ingest` gave it, and is made to
        // prove that anyway: this is the one command that reads a file the
        // webview names.
        let outside = std::env::temp_dir().join("coucou-not-inbox.png");
        std::fs::write(&outside, b"not really a png").unwrap();

        let err = preview(&outside.to_string_lossy()).unwrap_err();
        assert!(err.contains("inbox"), "got {err:?}");

        // And a path that does not resolve at all is not inside anything.
        assert!(preview("Z:/nope/a.png").is_err());
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn pasted_bytes_need_a_media_type_coucou_knows() {
        assert!(ingest_bytes("image/svg+xml", b"<svg/>").is_err());
        assert!(ingest_bytes("text/plain", b"hello").is_err());
        assert!(ingest_bytes("image/png", &vec![0u8; (MAX_IMAGE_BYTES + 1) as usize]).is_err());
    }
}
