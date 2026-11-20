//! Wi-Fi for the Mac running Muxtra: offer the network this Mac uses, read
//! its password from the Keychain (or ask for it), and keep only the
//! derived WPA key in muxtra.secrets. Also `muxtra wifi add | list | remove`.

use crate::style::{self, Role};
use crate::{Failure, files, prompt};
use clap::{Args, Subcommand};
use muxtra_build::wifi::{self, Network};
use muxtra_manifest::Network as Link;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Args)]
pub struct WifiArgs {
    #[command(subcommand)]
    action: WifiAction,
    /// Path to muxtra.toml, or the folder that holds it
    #[arg(long, default_value = ".", global = true)]
    manifest: PathBuf,
}

#[derive(Subcommand)]
enum WifiAction {
    /// Save a Wi-Fi network (offers the one this Mac uses)
    Add {
        /// The network name. Leave it out to pick the one this Mac uses.
        ssid: Option<String>,
        /// Read the password from piped input instead of asking
        #[arg(long)]
        password_stdin: bool,
    },
    /// Show the saved networks
    List,
    /// Forget a saved network
    Remove {
        /// The network name
        ssid: String,
    },
}

pub fn run(args: WifiArgs) -> Result<(), Failure> {
    let (path, manifest) = files::load_manifest(&args.manifest)?;
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut secrets = files::read_secrets(dir)?;
    let o = style::out();

    match args.action {
        WifiAction::List => {
            if secrets.wifi.is_empty() {
                println!(
                    "{}",
                    o.rich(
                        Role::Dim,
                        "No Wi-Fi networks saved. Add one with `muxtra wifi add`."
                    )
                );
            }
            for n in &secrets.wifi {
                println!("{}", o.paint(Role::Value, &n.ssid));
            }
            return Ok(());
        }
        WifiAction::Remove { ssid } => {
            let before = secrets.wifi.len();
            secrets.wifi.retain(|n| n.ssid != ssid);
            if secrets.wifi.len() == before {
                return Err(Failure(format!("No saved network is called \"{ssid}\".")));
            }
            files::save_secrets(dir, &secrets)?;
            println!(
                "{} Forgot {}.",
                o.paint(Role::Ok, "✓"),
                o.paint(Role::Value, &ssid)
            );
        }
        WifiAction::Add {
            ssid,
            password_stdin,
        } => {
            let network = match (ssid, password_stdin) {
                (Some(ssid), true) => {
                    let password = prompt::password_from_stdin()?;
                    Network {
                        psk: wifi::psk(&ssid, &password)?,
                        ssid,
                    }
                }
                (ssid, false) if prompt::someone_is_here() => match ssid {
                    Some(ssid) => Network {
                        psk: wifi::psk(&ssid, &password_for(&ssid)?)?,
                        ssid,
                    },
                    None => ask_network()?
                        .ok_or_else(|| Failure("No network was added.".to_string()))?,
                },
                _ => {
                    return Err(Failure(
                        "No one is at the keyboard to choose a network. Run `muxtra wifi add` yourself, or pass the name and pipe the password in: `muxtra wifi add NAME --password-stdin`.".to_string(),
                    ));
                }
            };
            let ssid = network.ssid.clone();
            save(&mut secrets, network);
            files::save_secrets(dir, &secrets)?;
            println!(
                "{} Saved {}. {}",
                o.paint(Role::Ok, "✓"),
                o.paint(Role::Value, &ssid),
                o.paint(
                    Role::Dim,
                    "Only a scrambled key is stored, never the password."
                )
            );
        }
    }
    if !manifest.modules.network.contains(&Link::Wifi) {
        println!(
            "{}",
            o.paint(Role::Warn, "muxtra.toml has no \"wifi\" in modules.network, so saved networks are not used until you add it.")
        );
    }
    println!(
        "{}",
        o.rich(Role::Dim, "It takes effect on the next `muxtra build`.")
    );
    Ok(())
}

/// Adds a network, replacing an older entry with the same name.
pub fn save(secrets: &mut files::Secrets, network: Network) {
    secrets.wifi.retain(|n| n.ssid != network.ssid);
    secrets.wifi.push(network);
}

/// The interactive question: "Use the Wi-Fi network X?" then the password
/// from the Keychain, or typed. Returns None when skipped.
pub fn ask_network() -> Result<Option<Network>, Failure> {
    let ssid = match this_macs_network() {
        Some(suggested) => {
            let answer = prompt::ask(
                &format!("Use the Wi-Fi network {suggested}? (Y/n)"),
                Some("Y"),
            )?;
            if answer.eq_ignore_ascii_case("y") || answer.eq_ignore_ascii_case("yes") {
                suggested
            } else {
                match prompt::ask("Wi-Fi network name (Enter to skip)", Some(""))? {
                    name if name.is_empty() => return Ok(None),
                    name => name,
                }
            }
        }
        None => match prompt::ask("Wi-Fi network name (Enter to skip)", Some(""))? {
            name if name.is_empty() => return Ok(None),
            name => name,
        },
    };
    wifi::check_ssid(&ssid)?;
    loop {
        let password = password_for(&ssid)?;
        match wifi::psk(&ssid, &password) {
            Ok(psk) => return Ok(Some(Network { ssid, psk })),
            Err(why) => println!("{why}"),
        }
    }
}

/// The password for a network: from this Mac's Keychain when it knows it
/// (macOS asks you to allow that), otherwise typed without showing it.
pub fn password_for(ssid: &str) -> Result<String, Failure> {
    if let Some(password) = keychain_password(ssid) {
        println!(
            "{}",
            style::out().paint(
                Role::Dim,
                &format!("Using the password for {ssid} from this Mac's Keychain.")
            )
        );
        return Ok(password);
    }
    Ok(
        prompt::new_password(&format!("Password for {ssid}"), false)?
            .expect("a required password is never skipped"),
    )
}

/// The Wi-Fi network this Mac is on. Newer macOS hides the name from
/// apps without location access, so fall back to the network this Mac
/// prefers most (the top of its saved list).
fn this_macs_network() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let ports = Command::new("networksetup")
        .arg("-listallhardwareports")
        .output()
        .ok()?;
    let ports = String::from_utf8_lossy(&ports.stdout);
    let device = ports
        .lines()
        .skip_while(|l| !l.contains("Wi-Fi"))
        .nth(1)?
        .strip_prefix("Device: ")?
        .trim()
        .to_string();
    let summary = Command::new("ipconfig")
        .args(["getsummary", &device])
        .output()
        .ok()?;
    let current = String::from_utf8_lossy(&summary.stdout)
        .lines()
        .find_map(|l| {
            l.trim()
                .strip_prefix("SSID : ")
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty() && s != "<redacted>");
    if current.is_some() {
        return current;
    }
    let saved = Command::new("networksetup")
        .args(["-listpreferredwirelessnetworks", &device])
        .output()
        .ok()?;
    String::from_utf8_lossy(&saved.stdout)
        .lines()
        .skip(1)
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// Reads a saved Wi-Fi password from the macOS Keychain. macOS shows its
/// own prompt to allow it. None if it is not there or not allowed.
fn keychain_password(ssid: &str) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = Command::new("security")
        .args([
            "find-generic-password",
            "-D",
            "AirPort network password",
            "-a",
            ssid,
            "-w",
        ])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let password = String::from_utf8_lossy(&out.stdout)
        .trim_end_matches('\n')
        .to_string();
    (out.status.success() && !password.is_empty()).then_some(password)
}
