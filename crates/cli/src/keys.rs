//! Turns `user.ssh_keys` into public keys: `"auto"` finds yours (or makes
//! one), lines that start like a key are used as written, anything else is
//! read as a path to a `.pub` file.

use crate::Failure;
use crate::style::{self, Role};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Default key files, in the order SSH itself tries them.
const DEFAULT_KEYS: &[&str] = &["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"];

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn expand(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None => PathBuf::from(path),
    }
}

fn looks_like_key(entry: &str) -> bool {
    ["ssh-", "ecdsa-", "sk-ssh-", "sk-ecdsa-"]
        .iter()
        .any(|p| entry.starts_with(p))
}

fn read_keys(path: &Path) -> Result<Vec<String>, Failure> {
    let text = fs::read_to_string(path)
        .map_err(|_| Failure(format!("Could not read the SSH key at {}.", path.display())))?;
    let keys: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|l| looks_like_key(l))
        .map(str::to_string)
        .collect();
    if keys.is_empty() {
        return Err(Failure(format!(
            "{} does not contain a public SSH key.",
            path.display()
        )));
    }
    Ok(keys)
}

/// Public keys to install, and the private key files that go with them
/// (for `muxtra check` to sign in with).
#[derive(Debug, Default)]
pub struct Resolved {
    pub public: Vec<String>,
    pub identities: Vec<PathBuf>,
}

/// Resolves every entry, without duplicates.
pub fn resolve(entries: &[String]) -> Result<Resolved, Failure> {
    let mut out = Resolved::default();
    for entry in entries {
        let (found, pub_file) = if entry == "auto" {
            auto_key()?
        } else if looks_like_key(entry) {
            (vec![entry.clone()], None)
        } else {
            let path = expand(entry);
            (read_keys(&path)?, Some(path))
        };
        for key in found {
            if !out.public.contains(&key) {
                out.public.push(key);
            }
        }
        if let Some(private) = pub_file.and_then(|p| private_for(&p))
            && !out.identities.contains(&private)
        {
            out.identities.push(private);
        }
    }
    Ok(out)
}

/// `~/.ssh/id_ed25519.pub` goes with `~/.ssh/id_ed25519`, if it exists.
fn private_for(public: &Path) -> Option<PathBuf> {
    let name = public.file_name()?.to_str()?.strip_suffix(".pub")?;
    let private = public.with_file_name(name);
    private.is_file().then_some(private)
}

/// Your usual SSH key, or a new one in the standard place if you have none,
/// so plain `ssh` works with no extra setup.
fn auto_key() -> Result<(Vec<String>, Option<PathBuf>), Failure> {
    let dir = home().join(".ssh");
    if let Some(found) = DEFAULT_KEYS
        .iter()
        .map(|k| dir.join(k))
        .find(|p| p.is_file())
    {
        return Ok((read_keys(&found)?, Some(found)));
    }
    fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    let private = dir.join("id_ed25519");
    let status = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&private)
        .status()
        .map_err(|_| Failure("Could not run ssh-keygen to make an SSH key.".to_string()))?;
    if !status.success() {
        return Err(Failure("ssh-keygen could not make an SSH key.".to_string()));
    }
    // To stderr, so it never mixes into output an agent is reading.
    let o = style::err();
    eprintln!(
        "{} {}",
        o.paint(Role::Ok, "✓"),
        o.paint(
            Role::Dim,
            &format!(
                "You had no SSH key, so Muxtra made one at {}.",
                private.display()
            )
        )
    );
    let public = dir.join("id_ed25519.pub");
    Ok((read_keys(&public)?, Some(public)))
}
