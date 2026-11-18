//! `muxtra.toml`: one file that describes a whole Muxtra system.
//!
//! This crate only reads and checks the file. It never touches the disk or the
//! network, so it is safe to call from anywhere, including tests.
//!
//! Every problem it reports is written for a person (or an agent) to act on:
//! what is wrong, where, and what to write instead.

use serde::{Deserialize, Serialize};
use std::fmt;

/// The file name Muxtra looks for.
pub const FILE_NAME: &str = "muxtra.toml";

/// Debian releases Muxtra can build on, newest last.
pub const SUPPORTED_DEBIAN: &[&str] = &["trixie"];

/// A parsed `muxtra.toml`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub system: System,
    pub base: Base,
    pub user: User,
    pub modules: Modules,
    pub boot: Boot,
    /// Optional settings for the tailscale module.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tailscale: Option<Tailscale>,
}

/// What this machine is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct System {
    /// Host name. Also how you reach it: `ssh <name>` or `<name>.local`.
    pub name: String,
    /// Mac model identifier, like `iMac14,4` or `MacBookPro15,1`.
    pub mac: String,
}

/// The Debian release underneath.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Base {
    pub debian: String,
}

/// The account on the machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct User {
    pub name: String,
    /// `true` when a password hash exists in `muxtra.secrets`. The password
    /// itself never lives in this file.
    #[serde(default)]
    pub password: bool,
    /// Public keys allowed to log in over SSH. `"auto"` finds yours, or makes one.
    #[serde(default = "default_ssh_keys")]
    pub ssh_keys: Vec<String>,
    /// Ask for the password before `sudo`. Off by default.
    #[serde(default, skip_serializing_if = "is_false")]
    pub sudo_password: bool,
}

fn default_ssh_keys() -> Vec<String> {
    vec!["auto".to_string()]
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// The parts list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Modules {
    #[serde(default)]
    pub network: Vec<Network>,
    #[serde(default)]
    pub remote: Vec<Remote>,
    /// Software installed out of the box, by name.
    #[serde(default)]
    pub tools: Vec<String>,
}

/// How the machine connects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    Ethernet,
    Wifi,
    /// A direct, fast link to another Mac over a Thunderbolt cable.
    Thunderbolt,
}

/// How you get into the machine from somewhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Remote {
    /// OpenSSH. Includes SFTP, scp and rsync.
    Ssh,
    /// SSH that survives Wi-Fi drops and sleep. Needs `ssh`.
    Mosh,
    Tailscale,
    Netbird,
    Zerotier,
    Wireguard,
    Cloudflared,
    Ngrok,
}

/// What happens at startup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Boot {
    /// Background services to start at boot.
    #[serde(default)]
    pub start: Vec<String>,
    /// Parts an agent cannot change until you unlock them.
    #[serde(default)]
    pub locked: Vec<Locked>,
}

/// Parts that can stop the machine from booting if they go wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Locked {
    Bootloader,
    Kernel,
}

/// Settings for the tailscale module.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tailscale {
    /// A self-hosted control server, such as Headscale. Leave unset for Tailscale's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
}

/// One thing wrong with a manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    /// Where, as a dotted path like `system.name`.
    pub field: String,
    /// What is wrong and how to fix it.
    pub message: String,
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.field, self.message)
    }
}

/// Why a manifest could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The file is not valid TOML, or a value has the wrong shape.
    Syntax(String),
    /// The file parsed, but some values do not make sense together.
    Invalid(Vec<Problem>),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Syntax(message) => write!(f, "{FILE_NAME} could not be read: {message}"),
            Error::Invalid(problems) => {
                let count = problems.len();
                let noun = if count == 1 { "problem" } else { "problems" };
                writeln!(f, "{FILE_NAME} has {count} {noun}:")?;
                for problem in problems {
                    writeln!(f, "  - {problem}")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for Error {}

impl Manifest {
    /// Parses and checks a manifest.
    pub fn parse(text: &str) -> Result<Manifest, Error> {
        let manifest: Manifest =
            toml::from_str(text).map_err(|e| Error::Syntax(e.to_string().trim().to_string()))?;
        let problems = manifest.problems();
        if problems.is_empty() {
            Ok(manifest)
        } else {
            Err(Error::Invalid(problems))
        }
    }

    /// Everything wrong with this manifest. Empty means it is good to build.
    pub fn problems(&self) -> Vec<Problem> {
        let mut out = Vec::new();
        let mut problem = |field: &str, message: String| {
            out.push(Problem {
                field: field.to_string(),
                message,
            })
        };

        if let Err(why) = check_host_name(&self.system.name) {
            problem("system.name", why);
        }
        if !is_mac_model(&self.system.mac) {
            problem(
                "system.mac",
                format!(
                    "\"{}\" does not look like a Mac model identifier. It should look like \"iMac14,4\" or \"MacBookPro15,1\". On the Mac itself, run `sysctl -n hw.model` to see it.",
                    self.system.mac
                ),
            );
        }
        if !SUPPORTED_DEBIAN.contains(&self.base.debian.as_str()) {
            problem(
                "base.debian",
                format!(
                    "Debian \"{}\" is not supported. Use one of: {}.",
                    self.base.debian,
                    SUPPORTED_DEBIAN.join(", ")
                ),
            );
        }
        if let Err(why) = check_user_name(&self.user.name) {
            problem("user.name", why);
        }
        if self.user.sudo_password && !self.user.password {
            problem(
                "user.sudo_password",
                "sudo cannot ask for a password when there is no password. Run `muxtra passwd` first, or set this to false.".to_string(),
            );
        }
        let ssh = self.modules.remote.contains(&Remote::Ssh);
        if self.modules.remote.contains(&Remote::Mosh) && !ssh {
            problem(
                "modules.remote",
                "mosh signs in through SSH, so it needs \"ssh\" in the list too.".to_string(),
            );
        }
        if self.user.ssh_keys.is_empty() && ssh {
            problem(
                "user.ssh_keys",
                "SSH is on but no keys are listed, so nobody could sign in. Use [\"auto\"] to find or make a key.".to_string(),
            );
        }
        for (field, items) in [
            ("modules.network", count_dupes(&self.modules.network)),
            ("modules.remote", count_dupes(&self.modules.remote)),
            ("modules.tools", count_dupes(&self.modules.tools)),
            ("boot.start", count_dupes(&self.boot.start)),
            ("boot.locked", count_dupes(&self.boot.locked)),
        ] {
            if items > 0 {
                problem(field, "lists the same thing more than once.".to_string());
            }
        }
        for service in &self.boot.start {
            if let Some(needs) = service_needs(service)
                && !self.modules.remote.contains(&needs)
            {
                problem(
                    "boot.start",
                    format!(
                        "\"{service}\" comes from the {} module, which is not in modules.remote. Add it there or remove \"{service}\" here.",
                        remote_name(needs)
                    ),
                );
            }
        }
        if self.tailscale.is_some() && !self.modules.remote.contains(&Remote::Tailscale) {
            problem(
                "tailscale",
                "has settings, but \"tailscale\" is not in modules.remote.".to_string(),
            );
        }
        if let Some(server) = self.tailscale.as_ref().and_then(|t| t.server.as_deref())
            && !server.starts_with("https://")
        {
            problem(
                "tailscale.server",
                "should be a full https:// address, like \"https://headscale.example.com\"."
                    .to_string(),
            );
        }
        out
    }

    /// Turns the manifest back into TOML.
    pub fn to_toml(&self) -> String {
        toml::to_string_pretty(self).expect("a manifest always serializes")
    }
}

/// Which remote module provides a known boot service.
fn service_needs(service: &str) -> Option<Remote> {
    match service {
        "sshd" | "ssh" => Some(Remote::Ssh),
        "tailscaled" => Some(Remote::Tailscale),
        "netbird" => Some(Remote::Netbird),
        "zerotier-one" => Some(Remote::Zerotier),
        "cloudflared" => Some(Remote::Cloudflared),
        _ => None,
    }
}

fn remote_name(remote: Remote) -> &'static str {
    match remote {
        Remote::Ssh => "ssh",
        Remote::Mosh => "mosh",
        Remote::Tailscale => "tailscale",
        Remote::Netbird => "netbird",
        Remote::Zerotier => "zerotier",
        Remote::Wireguard => "wireguard",
        Remote::Cloudflared => "cloudflared",
        Remote::Ngrok => "ngrok",
    }
}

fn count_dupes<T: PartialEq>(items: &[T]) -> usize {
    items
        .iter()
        .enumerate()
        .filter(|(i, item)| items[..*i].contains(item))
        .count()
}

/// Host names: 1 to 63 lowercase letters, digits and hyphens, not starting or
/// ending with a hyphen.
pub fn check_host_name(name: &str) -> Result<(), String> {
    let ok_chars = name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if name.is_empty()
        || name.len() > 63
        || !ok_chars
        || name.starts_with('-')
        || name.ends_with('-')
    {
        return Err(format!(
            "\"{name}\" is not a usable machine name. Use 1 to 63 lowercase letters, numbers and hyphens, like \"agent-box\"."
        ));
    }
    Ok(())
}

/// Linux user names: start with a lowercase letter, then lowercase letters,
/// digits, hyphens or underscores, 32 characters at most.
pub fn check_user_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_lowercase());
    let rest_ok =
        chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    let reserved = matches!(name, "root" | "daemon" | "bin" | "sys" | "nobody");
    if !first_ok || !rest_ok || name.len() > 32 {
        return Err(format!(
            "\"{name}\" is not a usable user name. Start with a lowercase letter and use lowercase letters, numbers, hyphens or underscores, like \"me\"."
        ));
    }
    if reserved {
        return Err(format!(
            "\"{name}\" is reserved by the system. Pick another name, like \"me\"."
        ));
    }
    Ok(())
}

/// Mac model identifiers look like a family name followed by `major,minor`,
/// for example `iMac14,4`, `Macmini8,1` or `MacBookPro15,1`.
pub fn is_mac_model(model: &str) -> bool {
    let Some(split) = model.find(|c: char| c.is_ascii_digit()) else {
        return false;
    };
    let (family, numbers) = model.split_at(split);
    let family_ok = family.len() >= 3 && family.chars().all(|c| c.is_ascii_alphabetic());
    let mut parts = numbers.split(',');
    let numbers_ok = matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(a), Some(b), None) if !a.is_empty() && !b.is_empty()
            && a.chars().all(|c| c.is_ascii_digit())
            && b.chars().all(|c| c.is_ascii_digit())
    );
    family_ok && numbers_ok
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT_BOX: &str = r#"
[system]
name = "agent-box"
mac  = "iMac14,4"

[base]
debian = "trixie"

[user]
name     = "me"
password = false
ssh_keys = ["auto"]

[modules]
network = ["ethernet", "wifi", "thunderbolt"]
remote  = ["ssh", "mosh", "tailscale"]
tools   = ["git", "node"]

[boot]
start  = ["sshd", "tailscaled"]
locked = ["bootloader", "kernel"]
"#;

    fn with(find: &str, replace: &str) -> String {
        assert!(AGENT_BOX.contains(find), "test fixture is missing {find:?}");
        AGENT_BOX.replacen(find, replace, 1)
    }

    fn problems(text: &str) -> Vec<String> {
        match Manifest::parse(text) {
            Ok(_) => vec![],
            Err(Error::Invalid(list)) => list.into_iter().map(|p| p.field).collect(),
            Err(Error::Syntax(message)) => panic!("unexpected syntax error: {message}"),
        }
    }

    #[test]
    fn agent_box_parses() {
        let m = Manifest::parse(AGENT_BOX).expect("agent-box should be valid");
        assert_eq!(m.system.name, "agent-box");
        assert_eq!(
            m.modules.remote,
            vec![Remote::Ssh, Remote::Mosh, Remote::Tailscale]
        );
        assert!(!m.user.password);
        assert!(!m.user.sudo_password);
    }

    #[test]
    fn round_trips_through_toml() {
        let m = Manifest::parse(AGENT_BOX).unwrap();
        let again = Manifest::parse(&m.to_toml()).unwrap();
        assert_eq!(m, again);
    }

    #[test]
    fn unknown_field_is_a_syntax_error() {
        let text = with("[base]", "[base]\ndebain = \"trixie\"");
        match Manifest::parse(&text) {
            Err(Error::Syntax(message)) => assert!(message.contains("debain"), "{message}"),
            other => panic!("expected a syntax error, got {other:?}"),
        }
    }

    #[test]
    fn unknown_module_is_a_syntax_error() {
        let text = with("\"wifi\"", "\"wiifi\"");
        assert!(matches!(Manifest::parse(&text), Err(Error::Syntax(_))));
    }

    #[test]
    fn bad_names_and_models() {
        assert_eq!(
            problems(&with("\"agent-box\"", "\"Agent Box\"")),
            ["system.name"]
        );
        assert_eq!(
            problems(&with("\"iMac14,4\"", "\"iMac 2014\"")),
            ["system.mac"]
        );
        assert_eq!(
            problems(&with("\"trixie\"", "\"bookworm\"")),
            ["base.debian"]
        );
        assert_eq!(
            problems(&with("name     = \"me\"", "name     = \"root\"")),
            ["user.name"]
        );
    }

    #[test]
    fn mosh_needs_ssh() {
        let text = with(
            "remote  = [\"ssh\", \"mosh\", \"tailscale\"]",
            "remote  = [\"mosh\", \"tailscale\"]",
        );
        let found = problems(&text);
        assert!(found.contains(&"modules.remote".to_string()), "{found:?}");
        // sshd at boot without the ssh module is also reported.
        assert!(found.contains(&"boot.start".to_string()), "{found:?}");
    }

    #[test]
    fn sudo_password_needs_a_password() {
        let text = with("password = false", "password = false\nsudo_password = true");
        assert_eq!(problems(&text), ["user.sudo_password"]);
    }

    #[test]
    fn duplicates_are_reported() {
        let text = with(
            "tools   = [\"git\", \"node\"]",
            "tools   = [\"git\", \"git\"]",
        );
        assert_eq!(problems(&text), ["modules.tools"]);
    }

    #[test]
    fn headscale_server_must_be_https() {
        let good =
            format!("{AGENT_BOX}\n[tailscale]\nserver = \"https://headscale.example.com\"\n");
        assert!(problems(&good).is_empty());
        let bad = format!("{AGENT_BOX}\n[tailscale]\nserver = \"headscale.example.com\"\n");
        assert_eq!(problems(&bad), ["tailscale.server"]);
    }

    #[test]
    fn starters_are_valid() {
        for (name, text) in [
            (
                "agent-box",
                include_str!("../../../starters/agent-box.toml"),
            ),
            ("blank", include_str!("../../../starters/blank.toml")),
        ] {
            if let Err(e) = Manifest::parse(text) {
                panic!("starter {name} is invalid: {e}");
            }
        }
    }

    #[test]
    fn mac_models() {
        for good in [
            "iMac14,4",
            "MacBookPro15,1",
            "Macmini8,1",
            "MacBookAir9,1",
            "iMacPro1,1",
        ] {
            assert!(is_mac_model(good), "{good}");
        }
        for bad in [
            "",
            "iMac",
            "iMac14",
            "iMac14,",
            "14,4",
            "iMac14,4,1",
            "Mac Book1,1",
        ] {
            assert!(!is_mac_model(bad), "{bad}");
        }
    }
}
