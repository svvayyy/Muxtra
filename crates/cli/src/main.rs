//! `muxtra`: build your own OS for an Intel Mac, with your agents.
//!
//! Every command works two ways. With a person at the keyboard it asks
//! friendly questions. With no keyboard (an agent, a script, CI) it never
//! waits: it uses the defaults and prints what it chose.

mod build;
mod check;
mod files;
mod host;
mod keys;
mod new;
mod passwd;
mod poof;
mod prompt;
mod remote;
mod style;
mod tailscale;
mod wifi;

use clap::{Args, CommandFactory, FromArgMatches, Parser, Subcommand};
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
    Build(build::BuildArgs),
    /// Report what works, in a virtual machine or on the real Mac
    Check(check::CheckArgs),
    /// Put Muxtra on a Mac, over a USB stick or a cable
    #[command(alias = "flash")]
    Poof(poof::PoofArgs),
    /// The admin step of poof that writes the drive
    #[command(name = "poof-write", hide = true)]
    PoofWrite(poof::PoofWriteArgs),
    /// Set or remove the password for the Mac's own keyboard
    Passwd(passwd::PasswdArgs),
    /// Save, list or forget Wi-Fi networks for the Mac
    Wifi(wifi::WifiArgs),
    /// Sign the Mac in to Tailscale, so you can reach it from anywhere
    Tailscale(tailscale::TailscaleArgs),
}

/// Where to find muxtra.toml.
#[derive(Args)]
pub struct ManifestArgs {
    /// Path to muxtra.toml, or the folder that holds it
    #[arg(long, default_value = ".")]
    pub manifest: PathBuf,
}

/// An error worth showing to a person, already in plain English.
#[derive(Debug)]
pub struct Failure(pub String);

impl<E: std::fmt::Display> From<E> for Failure {
    fn from(e: E) -> Self {
        Failure(e.to_string())
    }
}

fn main() -> ExitCode {
    let about = style::out().rich(
        Role::Plain,
        "A Linux base for Intel Macs, built for AI agents.\n\nStart with `muxtra new`, then `muxtra build`, `muxtra check` and `muxtra poof`.",
    );
    let matches = Cli::command()
        .styles(style::help_styles())
        .color(if style::colors_on() {
            clap::ColorChoice::Always
        } else {
            clap::ColorChoice::Never
        })
        .long_about(about)
        .get_matches();
    let cli = Cli::from_arg_matches(&matches).unwrap_or_else(|e| e.exit());
    let result = match cli.command {
        Command::New(args) => new::run(args),
        Command::Passwd(args) => passwd::run(args),
        Command::Wifi(args) => wifi::run(args),
        Command::Tailscale(args) => tailscale::run(args),
        Command::Build(args) => build::run(args),
        Command::Check(args) => check::run(args),
        Command::Poof(args) => poof::run(args),
        Command::PoofWrite(args) => poof::write(args),
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
