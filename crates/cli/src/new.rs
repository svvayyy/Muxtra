//! `muxtra new`: write a muxtra.toml from a starter.

use crate::style::{self, Role};
use crate::{Failure, files, prompt, wifi};
use clap::{Args, ValueEnum};
use muxtra_manifest::{FILE_NAME, Manifest, Remote, check_host_name, is_mac_model};
use std::fs;
use std::path::PathBuf;

const AGENT: &str = include_str!("../../../starters/agent.toml");
const BASE: &str = include_str!("../../../starters/base.toml");

/// What to start from.
#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Starter {
    /// A headless Mac for you and your agents (the default)
    Agent,
    /// Just the Muxtra base
    Base,
}

impl Starter {
    fn text(self) -> &'static str {
        match self {
            Starter::Agent => AGENT,
            Starter::Base => BASE,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Starter::Agent => "agent",
            Starter::Base => "base",
        }
    }

    /// The machine name the starter file is written with.
    fn default_name(self) -> &'static str {
        match self {
            Starter::Agent => "agent-box",
            Starter::Base => "muxtra",
        }
    }
}

#[derive(Args)]
pub struct NewArgs {
    /// Folder to create muxtra.toml in
    #[arg(default_value = ".")]
    dir: PathBuf,
    /// What to start from
    #[arg(long, value_enum, default_value_t = Starter::Agent)]
    starter: Starter,
    /// Machine name, like agent-box
    #[arg(long)]
    name: Option<String>,
    /// Model of the Mac that will run Muxtra, like iMac14,4
    #[arg(long)]
    mac: Option<String>,
    /// Do not set a password
    #[arg(long, conflicts_with = "password_stdin")]
    no_password: bool,
    /// Read a password from piped input instead of asking
    #[arg(long, conflicts_with = "wifi_password_stdin")]
    password_stdin: bool,
    /// Wi-Fi network for the Mac to join
    #[arg(long, conflicts_with = "no_wifi")]
    wifi_ssid: Option<String>,
    /// Read the Wi-Fi password from piped input (with --wifi-ssid)
    #[arg(long, requires = "wifi_ssid")]
    wifi_password_stdin: bool,
    /// Do not set up Wi-Fi now
    #[arg(long)]
    no_wifi: bool,
    /// Accept every default without asking
    #[arg(long, short = 'y')]
    yes: bool,
    /// Replace an existing muxtra.toml
    #[arg(long)]
    force: bool,
}

/// The Mac this command is running on.
struct ThisMac {
    model: String,
    intel: bool,
}

fn this_mac() -> Option<ThisMac> {
    #[cfg(target_os = "macos")]
    {
        let sysctl = |key: &str| {
            std::process::Command::new("sysctl")
                .args(["-n", key])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        };
        let model = sysctl("hw.model")?;
        // Stays "1" under Rosetta, so this reports the real chip.
        let arm = sysctl("hw.optional.arm64").is_some_and(|v| v == "1");
        Some(ThisMac { model, intel: !arm })
    }
    #[cfg(target_os = "linux")]
    {
        let read = |p: &str| fs::read_to_string(p).ok().map(|s| s.trim().to_string());
        let vendor = read("/sys/class/dmi/id/sys_vendor")?;
        if !vendor.contains("Apple") {
            return None;
        }
        let model = read("/sys/class/dmi/id/product_name")?;
        Some(ThisMac {
            model,
            intel: cfg!(target_arch = "x86_64"),
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

pub fn run(args: NewArgs) -> Result<(), Failure> {
    let interactive =
        prompt::someone_is_here() && !args.yes && !args.password_stdin && !args.wifi_password_stdin;
    let starter = args.starter;
    let path = args.dir.join(FILE_NAME);
    if path.exists() && !args.force {
        return Err(Failure(format!(
            "There is already a {} in {}. Use --force to replace it.",
            FILE_NAME,
            args.dir.display()
        )));
    }

    // Which Mac.
    let here = this_mac();
    let here_intel = here.as_ref().filter(|m| m.intel).map(|m| m.model.clone());
    let mac = match args.mac {
        Some(mac) => mac,
        None if interactive => loop {
            let answer = prompt::ask(
                "Which Mac will run Muxtra? (model, like iMac14,4)",
                here_intel.as_deref(),
            )?;
            if is_mac_model(&answer) {
                break answer;
            }
            println!(
                "That does not look like a Mac model. On that Mac, `sysctl -n hw.model` shows it."
            );
        },
        None => match &here_intel {
            Some(model) => model.clone(),
            None => {
                let why = match &here {
                    Some(m) => format!(
                        "This Mac ({}) has Apple Silicon, which Muxtra 1.0 does not support yet.",
                        m.model
                    ),
                    None => "Could not tell which Mac this is.".to_string(),
                };
                return Err(Failure(format!(
                    "{why} Pass the model of the Intel Mac that will run Muxtra, like --mac iMac14,4."
                )));
            }
        },
    };
    if !is_mac_model(&mac) {
        return Err(Failure(format!(
            "\"{mac}\" does not look like a Mac model. It should look like iMac14,4 or MacBookPro15,1. On that Mac, `sysctl -n hw.model` shows it."
        )));
    }

    // Its name.
    let name = match args.name {
        Some(name) => name,
        None if interactive => loop {
            let answer = prompt::ask("Name for this Mac", Some(starter.default_name()))?;
            match check_host_name(&answer) {
                Ok(()) => break answer,
                Err(why) => println!("{why}"),
            }
        },
        None => starter.default_name().to_string(),
    };
    check_host_name(&name).map_err(Failure)?;

    // A password, only if someone wants one.
    let password = if args.no_password {
        None
    } else if args.password_stdin {
        Some(prompt::password_from_stdin()?)
    } else if interactive {
        prompt::new_password("Password for this Mac's keyboard (Enter to skip)", true)?
    } else {
        None
    };
    let hash = password.as_deref().map(files::hash_password).transpose()?;

    // Fill in the starter, keeping its comments.
    let mut doc: toml_edit::DocumentMut = starter.text().parse().expect("starters are valid TOML");
    files::set_value(
        &mut doc,
        "system",
        "name",
        name.as_str().into(),
        Some((starter.default_name(), name.as_str())),
    );
    files::set_value(&mut doc, "system", "mac", mac.as_str().into(), None);
    // Leave out Thunderbolt networking on models where it cannot work.
    let no_thunderbolt = muxtra_build::hardware::no_thunderbolt(mac.as_str()).filter(|_| {
        doc["modules"]["network"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v.as_str() == Some("thunderbolt")))
    });
    if no_thunderbolt.is_some() {
        let kept: toml_edit::Array = doc["modules"]["network"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .filter(|v| *v != "thunderbolt")
                    .collect()
            })
            .unwrap_or_default();
        files::set_value(
            &mut doc,
            "modules",
            "network",
            kept.into(),
            Some((
                "thunderbolt: a rescue cable to another Mac",
                "no thunderbolt: this Mac's chip has no Linux driver",
            )),
        );
    }
    if hash.is_some() {
        files::set_value(&mut doc, "user", "password", true.into(), None);
    }
    let text = doc.to_string();
    let manifest = Manifest::parse(&text)?;

    // Wi-Fi, when this Mac will use it.
    let uses_wifi = manifest
        .modules
        .network
        .contains(&muxtra_manifest::Network::Wifi);
    let network = if !uses_wifi || args.no_wifi {
        None
    } else if let Some(ssid) = &args.wifi_ssid {
        let password = if args.wifi_password_stdin {
            prompt::password_from_stdin()?
        } else if interactive {
            wifi::password_for(ssid)?
        } else {
            return Err(Failure(
                "Pipe the Wi-Fi password in with --wifi-password-stdin, or run `muxtra wifi add` yourself later.".to_string(),
            ));
        };
        Some(muxtra_build::wifi::Network {
            psk: muxtra_build::wifi::psk(ssid, &password)?,
            ssid: ssid.clone(),
        })
    } else if interactive {
        wifi::ask_network()?
    } else {
        None
    };

    fs::create_dir_all(&args.dir)?;
    fs::write(&path, &text)?;
    files::save_secrets(
        &args.dir,
        &files::Secrets {
            password_hash: hash.clone(),
            wifi: network.iter().cloned().collect(),
        },
    )?;

    // Say what happened, in plain English.
    let this = if here.as_ref().is_some_and(|m| m.model == mac) {
        " (this Mac)"
    } else {
        ""
    };
    let o = style::out();
    let remote: Vec<String> = manifest
        .modules
        .remote
        .iter()
        .map(|r| match r {
            Remote::Ssh => format!(
                "{}{}",
                o.paint(Role::Value, "ssh"),
                o.paint(Role::Dim, " (includes SFTP)")
            ),
            other => o.paint(Role::Value, &format!("{other:?}").to_lowercase()),
        })
        .collect();
    println!(
        "{} Created {} from the {} starter.\n",
        o.paint(Role::Ok, "✓"),
        o.paint(Role::Cmd, &path.display().to_string()),
        o.paint(Role::Accent, starter.label())
    );
    println!(
        "  {} {}{}",
        o.label("Mac"),
        o.paint(Role::Value, &mac),
        o.paint(Role::Dim, this)
    );
    println!(
        "  {} {}{}",
        o.label("Name"),
        o.paint(Role::Value, &name),
        o.rich(
            Role::Dim,
            &format!(". Reach it with `ssh {name}` once Muxtra is on it.")
        )
    );
    if hash.is_some() {
        println!(
            "  {} {}{}",
            o.label("Password"),
            o.paint(Role::Ok, "set"),
            o.paint(
                Role::Dim,
                &format!(
                    ". Only a hash is stored, in {}, which git ignores.",
                    files::SECRETS_FILE
                )
            )
        );
    } else {
        println!(
            "  {} {}{}",
            o.label("Password"),
            o.paint(Role::Warn, "none"),
            o.paint(Role::Dim, ". Anyone at the Mac's keyboard can use it.")
        );
    }
    if uses_wifi {
        match &network {
            Some(n) => println!(
                "  {} {}{}",
                o.label("Wi-Fi"),
                o.paint(Role::Value, &n.ssid),
                o.paint(
                    Role::Dim,
                    ". Only a scrambled key is stored, never the password."
                )
            ),
            None => println!(
                "  {} {}{}",
                o.label("Wi-Fi"),
                o.paint(Role::Warn, "none yet"),
                o.rich(Role::Dim, ". Add a network with `muxtra wifi add`.")
            ),
        }
    }
    if let Some(why) = no_thunderbolt {
        println!(
            "  {}",
            o.paint(
                Role::Dim,
                &format!("Thunderbolt networking is left out: {why}.")
            )
        );
    }
    println!(
        "  {} {}",
        o.label("Remote"),
        if remote.is_empty() {
            o.paint(Role::Dim, "none")
        } else {
            remote.join(", ")
        }
    );
    println!(
        "  {} {}",
        o.label("Base"),
        o.paint(Role::Value, &format!("Debian {}", manifest.base.debian))
    );
    if hash.is_none() {
        println!(
            "\n{}",
            o.rich(
                Role::Dim,
                "To set a password later, run `muxtra passwd` yourself."
            )
        );
    }
    if !interactive {
        println!(
            "{}",
            o.paint(
                Role::Dim,
                "No one was at the keyboard, so Muxtra used defaults for anything not passed as a flag."
            )
        );
    }
    println!(
        "\n{} {} {}",
        o.paint(Role::Accent, "Next"),
        o.paint(Role::Dim, "→"),
        o.paint(Role::Cmd, "muxtra build")
    );
    Ok(())
}
