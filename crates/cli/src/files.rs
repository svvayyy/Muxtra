//! Reading and writing muxtra.toml and muxtra.secrets.

use crate::Failure;
use crate::style::{self, Role};
use muxtra_manifest::{Error, FILE_NAME, Manifest};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Where the password hash lives. Never committed.
pub const SECRETS_FILE: &str = "muxtra.secrets";

/// Accepts either a folder or a direct path to muxtra.toml.
pub fn manifest_path(path: &Path) -> PathBuf {
    if path.is_dir() {
        path.join(FILE_NAME)
    } else {
        path.to_path_buf()
    }
}

/// Reads and checks a manifest, with plain-English errors.
pub fn load_manifest(path: &Path) -> Result<(PathBuf, Manifest), Failure> {
    let path = manifest_path(path);
    let text = fs::read_to_string(&path).map_err(|_| {
        Failure(format!(
            "There is no {} here ({}). Run `muxtra new` to make one.",
            FILE_NAME,
            path.display()
        ))
    })?;
    let manifest = Manifest::parse(&text).map_err(|e| match e {
        Error::Syntax(message) => Failure(format!("{FILE_NAME} could not be read: {message}")),
        Error::Invalid(problems) => {
            let e = style::err();
            let count = problems.len();
            let noun = if count == 1 { "problem" } else { "problems" };
            eprintln!(
                "{} {} has {}:",
                e.paint(Role::Err, "✗"),
                e.paint(Role::Cmd, FILE_NAME),
                e.paint(Role::Cmd, &format!("{count} {noun}"))
            );
            for problem in problems {
                eprintln!(
                    "  {} {} {}",
                    e.paint(Role::Value, &problem.field),
                    e.paint(Role::Dim, "·"),
                    e.rich(Role::Plain, &problem.message)
                );
            }
            Failure(String::new())
        }
    })?;
    Ok((path, manifest))
}

/// The password hash from muxtra.secrets next to the manifest, if any.
pub fn read_password_hash(dir: &Path) -> Result<Option<String>, Failure> {
    let path = dir.join(SECRETS_FILE);
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(None);
    };
    let doc: toml_edit::DocumentMut = text
        .parse()
        .map_err(|e| Failure(format!("{SECRETS_FILE} could not be read: {e}")))?;
    Ok(doc
        .get("password_hash")
        .and_then(|v| v.as_str())
        .map(str::to_string))
}

/// Hashes a password for /etc/shadow (SHA-512 crypt, `$6$`).
pub fn hash_password(password: &str) -> Result<String, Failure> {
    use sha_crypt::{PasswordHasher, ShaCrypt};
    let hash = ShaCrypt::default()
        .hash_password(password.as_bytes())
        .map_err(|e| Failure(format!("Could not hash the password: {e}")))?;
    Ok(hash.as_str().to_string())
}

/// Writes (or replaces) the password hash, readable only by you, and makes
/// sure git ignores the file.
pub fn write_secrets(dir: &Path, password_hash: Option<&str>) -> Result<(), Failure> {
    let path = dir.join(SECRETS_FILE);
    match password_hash {
        Some(hash) => {
            let text = format!(
                "# Created by Muxtra. Keep this file private. Git ignores it.\n# Only a hash of the password is stored, never the password itself.\npassword_hash = \"{hash}\"\n"
            );
            write_private(&path, &text)?;
            ensure_gitignored(dir, SECRETS_FILE)?;
        }
        None => {
            if path.exists() {
                fs::remove_file(&path)?;
            }
        }
    }
    Ok(())
}

fn write_private(path: &Path, text: &str) -> Result<(), Failure> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(text.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Adds an entry to .gitignore in this folder if it is not there yet.
pub fn ensure_gitignored(dir: &Path, entry: &str) -> Result<(), Failure> {
    let path = dir.join(".gitignore");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == entry) {
        return Ok(());
    }
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(entry);
    text.push('\n');
    fs::write(&path, text)?;
    Ok(())
}

/// Sets a string or bool value in a TOML document, keeping its trailing
/// comment and keeping that comment lined up.
pub fn set_value(
    doc: &mut toml_edit::DocumentMut,
    table: &str,
    key: &str,
    value: toml_edit::Value,
    rename: Option<(&str, &str)>,
) {
    let item = &mut doc[table][key];
    let mut decor = item
        .as_value()
        .map(|v| v.decor().clone())
        .unwrap_or_default();
    // Measure values without their surrounding spaces and comments.
    let bare_len = |v: &toml_edit::Value| {
        let mut bare = v.clone();
        bare.decor_mut().clear();
        bare.to_string().len()
    };
    let old_len = item.as_value().map(bare_len).unwrap_or(0);
    let new_len = bare_len(&value);
    if let Some(suffix) = decor.suffix().and_then(|s| s.as_str()).map(str::to_string) {
        let comment_at = suffix.find('#');
        if let Some(at) = comment_at {
            let mut comment = suffix[at..].to_string();
            if let Some((from, to)) = rename {
                comment = comment.replace(from, to);
            }
            let pad = (old_len + at).saturating_sub(new_len).max(1);
            decor.set_suffix(format!("{}{}", " ".repeat(pad), comment));
        }
    }
    let mut value = value;
    *value.decor_mut() = decor;
    *item = toml_edit::Item::Value(value);
}
