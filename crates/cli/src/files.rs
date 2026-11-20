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

/// Everything kept in muxtra.secrets: never plain passwords, only a
/// password hash and the derived keys for saved Wi-Fi networks.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Secrets {
    pub password_hash: Option<String>,
    pub wifi: Vec<muxtra_build::wifi::Network>,
}

impl Secrets {
    fn is_empty(&self) -> bool {
        self.password_hash.is_none() && self.wifi.is_empty()
    }
}

/// Reads muxtra.secrets next to the manifest. A missing file is empty.
pub fn read_secrets(dir: &Path) -> Result<Secrets, Failure> {
    let path = dir.join(SECRETS_FILE);
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(Secrets::default());
    };
    let doc: toml_edit::DocumentMut = text
        .parse()
        .map_err(|e| Failure(format!("{SECRETS_FILE} could not be read: {e}")))?;
    let password_hash = doc
        .get("password_hash")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let mut wifi = Vec::new();
    if let Some(tables) = doc.get("wifi").and_then(|i| i.as_array_of_tables()) {
        for t in tables.iter() {
            let (Some(ssid), Some(psk)) = (
                t.get("ssid").and_then(|v| v.as_str()),
                t.get("psk").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            wifi.push(muxtra_build::wifi::Network {
                ssid: ssid.to_string(),
                psk: psk.to_string(),
            });
        }
    }
    Ok(Secrets {
        password_hash,
        wifi,
    })
}

/// Saves muxtra.secrets (readable only by you, ignored by git), or removes
/// it when there is nothing left to keep.
pub fn save_secrets(dir: &Path, secrets: &Secrets) -> Result<(), Failure> {
    let path = dir.join(SECRETS_FILE);
    if secrets.is_empty() {
        if path.exists() {
            fs::remove_file(&path)?;
        }
        return Ok(());
    }
    let quoted = |v: &str| toml_edit::Value::from(v).to_string();
    let mut text = String::from(
        "# Created by Muxtra. Keep this file private. Git ignores it.\n\
         # Only a password hash and scrambled Wi-Fi keys live here, never your passwords themselves.\n",
    );
    if let Some(hash) = &secrets.password_hash {
        text.push_str(&format!("password_hash = {}\n", quoted(hash)));
    }
    for n in &secrets.wifi {
        text.push_str(&format!(
            "\n[[wifi]]\nssid = {}\npsk = {}\n",
            quoted(&n.ssid),
            quoted(&n.psk)
        ));
    }
    write_private(&path, &text)?;
    ensure_gitignored(dir, SECRETS_FILE)
}

/// Hashes a password for /etc/shadow (SHA-512 crypt, `$6$`).
pub fn hash_password(password: &str) -> Result<String, Failure> {
    use sha_crypt::{PasswordHasher, ShaCrypt};
    let hash = ShaCrypt::default()
        .hash_password(password.as_bytes())
        .map_err(|e| Failure(format!("Could not hash the password: {e}")))?;
    Ok(hash.as_str().to_string())
}

/// Sets or removes the password hash, keeping any saved Wi-Fi networks.
pub fn write_secrets(dir: &Path, password_hash: Option<&str>) -> Result<(), Failure> {
    let mut secrets = read_secrets(dir)?;
    secrets.password_hash = password_hash.map(str::to_string);
    save_secrets(dir, &secrets)
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
