//! `muxtra passwd`: set or remove the password for the Mac's own keyboard.
//!
//! The password never goes in muxtra.toml. Only a hash is kept, in
//! muxtra.secrets next to it, and git is told to ignore that file.

use crate::style::{self, Role};
use crate::{Failure, files, prompt};
use clap::Args;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Args)]
pub struct PasswdArgs {
    /// Path to muxtra.toml, or the folder that holds it
    #[arg(long, default_value = ".")]
    manifest: PathBuf,
    /// Read the password from piped input instead of asking
    #[arg(long)]
    password_stdin: bool,
    /// Remove the password, so the Mac signs in on its own
    #[arg(long, conflicts_with = "password_stdin")]
    remove: bool,
}

pub fn run(args: PasswdArgs) -> Result<(), Failure> {
    let path = files::manifest_path(&args.manifest);
    let text = fs::read_to_string(&path).map_err(|_| {
        Failure(format!(
            "There is no muxtra.toml here ({}). Run `muxtra new` first.",
            path.display()
        ))
    })?;
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut doc: toml_edit::DocumentMut = text
        .parse()
        .map_err(|e| Failure(format!("muxtra.toml could not be read: {e}")))?;

    if args.remove {
        files::set_value(&mut doc, "user", "password", false.into(), None);
        if let Some(user) = doc["user"].as_table_mut() {
            user.remove("sudo_password");
        }
        fs::write(&path, doc.to_string())?;
        files::write_secrets(dir, None)?;
        let o = style::out();
        println!(
            "{} Removed the password. {}",
            o.paint(Role::Ok, "✓"),
            o.paint(Role::Warn, "Anyone at the Mac's keyboard can use it.")
        );
        println!(
            "{}",
            o.rich(Role::Dim, "It takes effect on the next `muxtra build`.")
        );
        return Ok(());
    }

    let password = if args.password_stdin {
        prompt::password_from_stdin()?
    } else if prompt::someone_is_here() {
        prompt::new_password("New password for this Mac's keyboard", false)?
            .expect("a required password is never skipped")
    } else {
        return Err(Failure(
            "No one is at the keyboard to type a password. Run `muxtra passwd` yourself in a terminal, or pipe one in with --password-stdin."
                .to_string(),
        ));
    };
    let hash = files::hash_password(&password)?;
    files::write_secrets(dir, Some(&hash))?;
    files::set_value(&mut doc, "user", "password", true.into(), None);
    fs::write(&path, doc.to_string())?;
    let o = style::out();
    println!(
        "{} Password set. {}",
        o.paint(Role::Ok, "✓"),
        o.paint(
            Role::Dim,
            &format!(
                "Only a hash is stored, in {}, which git ignores.",
                files::SECRETS_FILE
            )
        )
    );
    println!(
        "{}",
        o.rich(Role::Dim, "It takes effect on the next `muxtra build`.")
    );
    Ok(())
}
