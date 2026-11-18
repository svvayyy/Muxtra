//! `muxtra`: build your own OS for an Intel Mac, with your agents.
//!
//! Every command works two ways. With a person at the keyboard it asks
//! friendly questions. With no keyboard (an agent, a script, CI) it never
//! waits: it uses the defaults and prints what it chose.

mod files;
mod new;
mod passwd;
mod prompt;
mod style;

use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;
use style::Role;

#[derive(Parser)]
#[command(
    name = "muxtra",
    version,
    about = "A Linux base for Intel Macs, built for AI agents.",
    long_about = "A Linux base for Intel Macs, built for AI agents.\n\nStart with `muxtra new`, then `muxtra build`, `muxtra check` and `muxtra poof`."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Start a muxtra.toml for a Mac
    New(new::NewArgs),
    /// Build a system image from muxtra.toml
    Build(ManifestArgs),
    /// Boot the image in a virtual machine and report what works
    Check(ManifestArgs),
    /// Put Muxtra on a Mac, over a USB stick or a cable
    #[command(alias = "flash")]
    Poof(ManifestArgs),
    /// Set or remove the password for the Mac's own keyboard
    Passwd(passwd::PasswdArgs),
}

/// Where to find muxtra.toml.
#[derive(Args)]
pub struct ManifestArgs {
    /// Path to muxtra.toml, or the folder that holds it
    #[arg(long, default_value = ".")]
    pub manifest: PathBuf,
}

/// An error worth showing to a person, already in plain English.
pub struct Failure(pub String);

impl<E: std::fmt::Display> From<E> for Failure {
    fn from(e: E) -> Self {
        Failure(e.to_string())
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::New(args) => new::run(args),
        Command::Passwd(args) => passwd::run(args),
        Command::Build(args) => not_yet(&args, "Building", "next up in Phase 1"),
        Command::Check(args) => {
            not_yet(&args, "Checking in a virtual machine", "coming in Phase 1")
        }
        Command::Poof(args) => not_yet(&args, "Putting Muxtra on a Mac", "coming in Phase 2"),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(Failure(message)) => {
            // An empty message means the command already explained itself.
            if !message.is_empty() {
                let e = style::err();
                eprintln!(
                    "{} {}",
                    e.paint(Role::Err, "✗"),
                    e.rich(Role::Plain, message.trim_end())
                );
            }
            ExitCode::FAILURE
        }
    }
}

/// Commands that exist but are not built yet still read and check the
/// manifest, so they are useful today.
fn not_yet(args: &ManifestArgs, what: &str, when: &str) -> Result<(), Failure> {
    let (path, manifest) = files::load_manifest(&args.manifest)?;
    let o = style::out();
    println!(
        "{} {} looks good: {} for {}.",
        o.paint(Role::Ok, "✓"),
        o.paint(Role::Cmd, &path.display().to_string()),
        o.paint(Role::Value, &manifest.system.name),
        o.paint(Role::Value, &manifest.system.mac)
    );
    let e = style::err();
    eprintln!(
        "{} {}",
        e.paint(Role::Warn, "!"),
        e.paint(
            Role::Warn,
            &format!("{what} is not ready yet. It is {when}.")
        )
    );
    Err(Failure(String::new()))
}
