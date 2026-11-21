//! `muxtra tailscale login`: sign a Mac running Muxtra in to Tailscale.
//!
//! It connects to the Mac over SSH, starts Tailscale's normal sign-in and
//! shows the link. You open it in a browser and sign in. No keys to create
//! or store. With someone at the keyboard it waits until the Mac is
//! connected. An agent gets the link right away to pass on to a person.

use crate::remote::Mac;
use crate::style::{self, Role, say};
use crate::{Failure, files, keys, prompt};
use clap::{Args, Subcommand};
use muxtra_build::tailscale::{self, State};
use muxtra_manifest::Remote;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[derive(Args)]
pub struct TailscaleArgs {
    #[command(subcommand)]
    action: TailscaleAction,
    /// Path to muxtra.toml, or the folder that holds it
    #[arg(long, default_value = ".", global = true)]
    manifest: PathBuf,
}

#[derive(Subcommand)]
enum TailscaleAction {
    /// Sign the Mac in to Tailscale with a link you open in your browser
    Login(LoginArgs),
}

#[derive(Args)]
struct LoginArgs {
    /// Where to reach the Mac, like an IP address (default: <name>.local)
    #[arg(long)]
    host: Option<String>,
    /// Wait until the sign-in is finished (the default when you are at the keyboard)
    #[arg(long, conflicts_with = "no_wait")]
    wait: bool,
    /// Show the link and stop, without waiting (the default for agents)
    #[arg(long)]
    no_wait: bool,
    /// Print the result as JSON, for agents and scripts
    #[arg(long)]
    json: bool,
}

/// How long the Mac waits for someone to finish signing in.
const WAIT_SECS: u64 = 600;

pub fn run(args: TailscaleArgs) -> Result<(), Failure> {
    match args.action {
        TailscaleAction::Login(login) => run_login(&args.manifest, login),
    }
}

fn run_login(manifest: &std::path::Path, args: LoginArgs) -> Result<(), Failure> {
    if args.json {
        style::send_progress_to_stderr();
    }
    let (_, manifest) = files::load_manifest(manifest)?;
    let name = manifest.system.name.clone();
    if !manifest.modules.remote.contains(&Remote::Tailscale) {
        return Err(Failure(format!(
            "muxtra.toml has no \"tailscale\" in modules.remote, so {name} does not have Tailscale. Add it, then `muxtra build` and `muxtra poof` again."
        )));
    }
    if !manifest.modules.remote.contains(&Remote::Ssh) {
        return Err(Failure(
            "Signing in happens over SSH, and muxtra.toml has no \"ssh\" in modules.remote. Run `sudo tailscale login` on the Mac itself instead.".to_string(),
        ));
    }
    let mac = Mac::new(
        args.host.clone(),
        &name,
        &manifest.user.name,
        keys::resolve(&manifest.user.ssh_keys)?.identities,
    );
    let o = style::progress();
    say(&o.paint(Role::Dim, &format!("Connecting to {}...", mac.target)));

    match current_state(&mac, &name)? {
        State::NeedsLogin | State::Other(_) => {}
        done => return report(&name, &mac, done, args.json),
    }

    let wait = args.wait || (!args.no_wait && !args.json && prompt::someone_is_here());
    let mut child = Command::new("ssh")
        .args(mac.options())
        .args(["-o", "ServerAliveInterval=15"])
        .arg(mac.destination())
        .arg(tailscale::login_command(WAIT_SECS))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| Failure("Could not run ssh on this Mac.".to_string()))?;
    let mut said = Vec::new();
    let mut url = None;
    let mut lines = BufReader::new(child.stdout.take().expect("stdout is piped")).lines();
    for line in lines.by_ref() {
        let Ok(line) = line else { break };
        if let Some(found) = tailscale::login_url(&line) {
            url = Some(found.to_string());
            break;
        }
        if !line.trim().is_empty() {
            said.push(line);
        }
    }

    let Some(url) = url else {
        let status = child.wait_with_output()?;
        if status.status.success() {
            // It finished without a link: it was already signing in.
            let state = current_state(&mac, &name)?;
            return report(&name, &mac, state, args.json);
        }
        let stderr = String::from_utf8_lossy(&status.stderr).into_owned();
        if status.status.code() == Some(255) {
            return Err(Failure(mac.problem(&stderr)));
        }
        return Err(Failure(format!(
            "Tailscale on {name} could not start signing in. It said: {}",
            said.join(" ").trim()
        )));
    };

    if !wait {
        // The link stays valid after this: Tailscale on the Mac keeps waiting.
        let _ = child.kill();
        let _ = child.wait();
        if args.json {
            print_json(serde_json::json!({ "state": "needs-login", "url": url }));
        } else {
            let o = style::out();
            println!(
                "Open this link and sign in to Tailscale:\n\n  {}\n",
                o.paint(Role::Value, &url)
            );
            println!(
                "{}",
                o.rich(
                    Role::Dim,
                    &format!("After signing in, run `muxtra tailscale login` again to see that {name} is connected.")
                )
            );
        }
        return Ok(());
    }

    let o = style::out();
    println!(
        "Open this link and sign in to Tailscale:\n\n  {}\n",
        o.paint(Role::Value, &url)
    );
    say(&style::progress().paint(
        Role::Dim,
        "Waiting for you to finish. Ctrl-C stops waiting, and the link keeps working.",
    ));
    // Keep reading, so ssh is never cut off while the Mac waits.
    for _ in lines {}
    let _ = child.wait();
    let state = current_state(&mac, &name)?;
    if matches!(state, State::NeedsLogin | State::Other(_)) {
        return Err(Failure(format!(
            "The sign-in was not finished within {} minutes. Run `muxtra tailscale login` again for a new link.",
            WAIT_SECS / 60
        )));
    }
    report(&name, &mac, state, args.json)
}

/// Asks Tailscale on the Mac where it is.
fn current_state(mac: &Mac, name: &str) -> Result<State, Failure> {
    let text = mac.run(tailscale::STATUS_COMMAND, None)?;
    if text.trim() == "not-installed" {
        return Err(Failure(format!(
            "Tailscale is not installed on {name}. The image was built before \"tailscale\" was in muxtra.toml: run `muxtra build` and `muxtra poof` again."
        )));
    }
    Ok(tailscale::state(&text)?)
}

fn report(name: &str, mac: &Mac, state: State, json: bool) -> Result<(), Failure> {
    let o = style::out();
    match state {
        State::SignedIn {
            name: dns,
            ips,
            tailnet,
        } => {
            if json {
                print_json(
                    serde_json::json!({ "state": "signed-in", "name": dns, "ips": ips, "tailnet": tailnet }),
                );
                return Ok(());
            }
            let place = match (dns.is_empty(), ips.first()) {
                (false, Some(ip)) => format!(" as {} ({ip})", o.paint(Role::Value, &dns)),
                (false, None) => format!(" as {}", o.paint(Role::Value, &dns)),
                (true, Some(ip)) => format!(" at {}", o.paint(Role::Value, ip)),
                (true, None) => String::new(),
            };
            println!(
                "{} {} is signed in to Tailscale{place}.",
                o.paint(Role::Ok, "✓"),
                o.paint(Role::Value, name)
            );
            if !tailnet.is_empty() {
                println!(
                    "{}",
                    o.rich(
                        Role::Dim,
                        &format!("Tailnet: {tailnet}. Only devices signed in to this same tailnet can reach it.")
                    )
                );
            }
            let short = dns.split('.').next().unwrap_or(name);
            if !short.is_empty() {
                println!(
                    "{}",
                    o.rich(
                        Role::Dim,
                        &format!(
                            "From any device on your tailnet: `ssh {}@{short}`",
                            mac.user
                        )
                    )
                );
            }
        }
        State::NeedsApproval => {
            if json {
                print_json(serde_json::json!({ "state": "needs-approval" }));
                return Ok(());
            }
            println!(
                "{} {} is signed in, but your tailnet needs an admin to approve it. Approve it at {}.",
                o.paint(Role::Warn, "!"),
                o.paint(Role::Value, name),
                o.paint(Role::Value, "https://login.tailscale.com/admin/machines")
            );
        }
        State::NeedsLogin | State::Other(_) => {
            return Err(Failure(format!(
                "{name} is not signed in to Tailscale yet. Run `muxtra tailscale login` again."
            )));
        }
    }
    Ok(())
}

fn print_json(doc: serde_json::Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(&doc).expect("JSON always serializes")
    );
}
