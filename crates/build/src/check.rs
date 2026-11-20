//! What `muxtra check` asks a booted system, and how it turns the answers
//! into a plain-English report.
//!
//! The probe script runs over SSH inside the VM and prints one
//! `key<TAB>value` line per fact. Everything here is pure, so it is tested
//! without a VM.

use crate::Plan;
use muxtra_manifest::{Manifest, Network, Remote};
use std::collections::BTreeMap;

/// How one check came out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Pass,
    Fail,
    /// Cannot be tested in a VM. Only a real Mac can say.
    RealMac,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Pass => "pass",
            Status::Fail => "fail",
            Status::RealMac => "needs-real-mac",
        }
    }
}

/// One row of the report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    /// Short label, like "Node".
    pub name: String,
    pub status: Status,
    /// What was found, in plain English.
    pub detail: String,
}

impl Check {
    fn new(name: &str, status: Status, detail: impl Into<String>) -> Check {
        Check {
            name: name.to_string(),
            status,
            detail: detail.into(),
        }
    }
}

/// Debian packages from `tools` (not Node, which comes from NodeSource).
fn tool_packages(manifest: &Manifest) -> Vec<String> {
    manifest
        .modules
        .tools
        .iter()
        .filter(|t| *t != "node" && *t != "nodejs" && !t.starts_with("node@"))
        .cloned()
        .collect()
}

/// Debian's unit name for a boot service.
fn unit(service: &str) -> &str {
    if service == "sshd" { "ssh" } else { service }
}

/// The script `muxtra check` runs inside the VM over SSH.
pub fn probe_script(manifest: &Manifest) -> String {
    let mut s = String::from(
        "#!/bin/bash\n\
         # Written by muxtra check. Prints one fact per line: key<TAB>value.\n\
         fact() { printf '%s\\t%s\\n' \"$1\" \"$2\"; }\n\
         fact state \"$(timeout 120 systemctl is-system-running --wait 2>/dev/null)\"\n\
         fact failed \"$(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | paste -sd, -)\"\n\
         fact running \"$(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | wc -l)\"\n\
         fact hostname \"$(hostname)\"\n\
         fact memory \"$(free -m | awk '/^Mem:/{print $3}')\"\n\
         fact disk \"$(df -m / | awk 'NR==2{print $3}')\"\n\
         fact slots \"$(lsblk -no PARTLABEL 2>/dev/null | grep -c '^muxtra-')\"\n\
         sudo -n true 2>/dev/null && fact sudo nopass || fact sudo pass\n",
    );
    for service in &manifest.boot.start {
        let u = unit(service);
        s.push_str(&format!(
            "fact service:{u} \"$(systemctl is-active {} 2>/dev/null)\"\n",
            crate::quote(u)
        ));
    }
    if manifest.modules.network.contains(&Network::Wifi) {
        s.push_str(
            "fact service:iwd \"$(systemctl is-active iwd 2>/dev/null)\"\n\
             fact wifi-networks \"$(sudo -n sh -c 'ls /var/lib/iwd/*.psk 2>/dev/null | wc -l' 2>/dev/null)\"\n",
        );
    }
    s.push_str("command -v node >/dev/null && fact node \"$(node --version)\"\n");
    if manifest.modules.remote.contains(&Remote::Tailscale) {
        s.push_str(
            "command -v tailscale >/dev/null && fact tailscale \"$(tailscale version 2>/dev/null | head -1)\"\n\
             fact tailscale-state \"$(tailscale status --json 2>/dev/null | grep -o '\"BackendState\": *\"[A-Za-z]*\"' | grep -o '[A-Za-z]*\"$' | tr -d '\"')\"\n",
        );
    }
    if manifest.modules.remote.contains(&Remote::Mosh) {
        s.push_str("command -v mosh-server >/dev/null && fact mosh yes\n");
    }
    for pkg in tool_packages(manifest) {
        s.push_str(&format!(
            "fact pkg:{pkg} \"$(dpkg-query -W -f='${{Status}}' {} 2>/dev/null)\"\n",
            crate::quote(&pkg)
        ));
    }
    s
}

/// Reads the probe's `key<TAB>value` lines.
pub fn parse_facts(output: &str) -> BTreeMap<String, String> {
    output
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect()
}

/// What the host saw before the probe ran.
#[derive(Debug, Clone, Default)]
pub struct Observed {
    /// Seconds from power on to the login prompt, if it got there.
    pub boot_seconds: Option<u64>,
    /// Whether SSH with your key worked.
    pub ssh: bool,
    /// Whether an SFTP session worked.
    pub sftp: bool,
}

/// Turns everything that was seen into the report rows.
pub fn report(
    manifest: &Manifest,
    plan: &Plan,
    seen: &Observed,
    facts: &BTreeMap<String, String>,
) -> Vec<Check> {
    let mut out = Vec::new();
    let fact = |k: &str| facts.get(k).map(String::as_str).unwrap_or("");
    let has = |r: Remote| manifest.modules.remote.contains(&r);

    out.push(match seen.boot_seconds {
        Some(s) => Check::new("Boots", Status::Pass, format!("login in {s}s")),
        None => Check::new("Boots", Status::Fail, "never reached the login prompt"),
    });

    if has(Remote::Ssh) {
        out.push(match (seen.ssh, seen.sftp) {
            (true, true) => Check::new(
                "SSH",
                Status::Pass,
                "you're in with your key (SFTP included)",
            ),
            (true, false) => Check::new("SSH", Status::Fail, "SSH works, but SFTP did not"),
            _ => Check::new("SSH", Status::Fail, "could not sign in with your key"),
        });
    }
    if !seen.ssh {
        // Nothing else can be checked without a way in.
        return out;
    }

    let failed: Vec<&str> = fact("failed")
        .split(',')
        .filter(|s| !s.is_empty())
        .collect();
    // Services that must be running: everything in boot.start, plus the
    // Wi-Fi manager on Macs with Wi-Fi.
    let mut expected: Vec<String> = manifest
        .boot
        .start
        .iter()
        .map(|s| unit(s).to_string())
        .collect();
    if manifest.modules.network.contains(&Network::Wifi) {
        expected.push("iwd".to_string());
    }
    let not_running: Vec<String> = expected
        .into_iter()
        .filter(|u| fact(&format!("service:{u}")) != "active")
        .collect();
    out.push(
        if failed.is_empty() && not_running.is_empty() && fact("state") == "running" {
            Check::new(
                "Services",
                Status::Pass,
                format!("{} running, none failed", fact("running")),
            )
        } else if !failed.is_empty() {
            let noun = if failed.len() == 1 {
                "service"
            } else {
                "services"
            };
            Check::new(
                "Services",
                Status::Fail,
                format!("{} {noun} failed: {}", failed.len(), failed.join(", ")),
            )
        } else if !not_running.is_empty() {
            Check::new(
                "Services",
                Status::Fail,
                format!("not running: {}", not_running.join(", ")),
            )
        } else {
            Check::new(
                "Services",
                Status::Fail,
                format!("the system says it is \"{}\"", fact("state")),
            )
        },
    );

    if let Some(major) = plan.node_major {
        let version = fact("node");
        let wanted = format!("v{major}.");
        out.push(if version.starts_with(&wanted) {
            Check::new("Node", Status::Pass, version)
        } else if version.is_empty() {
            Check::new("Node", Status::Fail, "not installed")
        } else {
            Check::new(
                "Node",
                Status::Fail,
                format!("{version}, but muxtra.toml asks for Node {major}"),
            )
        });
    }

    if has(Remote::Tailscale) {
        let version = fact("tailscale");
        out.push(match (version.is_empty(), fact("tailscale-state")) {
            (true, _) => Check::new("Tailscale", Status::Fail, "not installed"),
            (false, "Running") => Check::new("Tailscale", Status::Pass, "installed and signed in"),
            (false, _) => Check::new("Tailscale", Status::Pass, "installed, not signed in yet"),
        });
    }

    if has(Remote::Mosh) {
        out.push(if fact("mosh") == "yes" {
            Check::new("mosh", Status::Pass, "ready")
        } else {
            Check::new("mosh", Status::Fail, "not installed")
        });
    }

    let tools = tool_packages(manifest);
    if !tools.is_empty() {
        let missing: Vec<&String> = tools
            .iter()
            .filter(|p| !fact(&format!("pkg:{p}")).contains("installed"))
            .collect();
        out.push(if missing.is_empty() {
            Check::new(
                "Tools",
                Status::Pass,
                format!("{} installed", tools.join(", ")),
            )
        } else {
            Check::new(
                "Tools",
                Status::Fail,
                format!(
                    "missing: {}",
                    missing
                        .iter()
                        .map(|s| s.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            )
        });
    }

    let sudo_ok = if manifest.user.sudo_password {
        fact("sudo") == "pass"
    } else {
        fact("sudo") == "nopass"
    };
    out.push(match (sudo_ok, manifest.user.sudo_password) {
        (true, false) => Check::new("sudo", Status::Pass, "works without a password"),
        (true, true) => Check::new("sudo", Status::Pass, "asks for your password"),
        (false, false) => Check::new("sudo", Status::Fail, "asks for a password, but should not"),
        (false, true) => Check::new(
            "sudo",
            Status::Fail,
            "does not ask for a password, but should",
        ),
    });

    let memory = fact("memory");
    if !memory.is_empty() {
        out.push(Check::new(
            "Memory",
            Status::Pass,
            format!("{memory} MB used at idle"),
        ));
    }
    let slots = fact("slots");
    let disk = fact("disk")
        .parse::<f64>()
        .map(|mb| format!("{:.1} GB used", mb / 1024.0))
        .unwrap_or_default();
    out.push(if slots == "4" {
        Check::new("Disk", Status::Pass, format!("{disk}, slots A and B ready"))
    } else {
        Check::new(
            "Disk",
            Status::Fail,
            "the Muxtra partitions are not all there",
        )
    });

    let network = &manifest.modules.network;
    if network.contains(&Network::Wifi) {
        let saved: usize = fact("wifi-networks").parse().unwrap_or(0);
        let detail = match saved {
            0 => "no networks saved yet. Run `muxtra wifi add`, then build again".to_string(),
            1 => "1 network saved. It joins on a real Mac".to_string(),
            n => format!("{n} networks saved. They join on a real Mac"),
        };
        out.push(Check::new("Wi-Fi", Status::RealMac, detail));
    }
    if network.contains(&Network::Thunderbolt) {
        out.push(Check::new(
            "Thunderbolt",
            Status::RealMac,
            "can't be tested in a VM, needs a real Mac",
        ));
    }
    out
}

/// Counts for the summary line: (passed, failed, need a real Mac).
pub fn tally(checks: &[Check]) -> (usize, usize, usize) {
    let count = |s: Status| checks.iter().filter(|c| c.status == s).count();
    (
        count(Status::Pass),
        count(Status::Fail),
        count(Status::RealMac),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Inputs, plan};

    const AGENT_BOX: &str = include_str!("../../../starters/agent-box.toml");

    fn setup(text: &str) -> (Manifest, Plan) {
        let m = Manifest::parse(text).unwrap();
        let p = plan(
            &m,
            &Inputs {
                ssh_keys: vec!["ssh-ed25519 AAAA test".into()],
                password_hash: None,
                wifi: vec![],
            },
        )
        .unwrap();
        (m, p)
    }

    fn healthy() -> BTreeMap<String, String> {
        parse_facts(
            "state\trunning\nfailed\t\nrunning\t21\nhostname\tagent-box\nmemory\t239\ndisk\t1100\n\
             slots\t4\nsudo\tnopass\nservice:ssh\tactive\nservice:tailscaled\tactive\nnode\tv26.13.1\n\
             tailscale\t1.104.7\ntailscale-state\tNeedsLogin\nmosh\tyes\npkg:git\tinstall ok installed\n\
             service:iwd\tactive\nwifi-networks\t1\n",
        )
    }

    fn seen() -> Observed {
        Observed {
            boot_seconds: Some(24),
            ssh: true,
            sftp: true,
        }
    }

    #[test]
    fn healthy_agent_box() {
        let (m, p) = setup(AGENT_BOX);
        let checks = report(&m, &p, &seen(), &healthy());
        let names: Vec<&str> = checks.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Boots",
                "SSH",
                "Services",
                "Node",
                "Tailscale",
                "mosh",
                "Tools",
                "sudo",
                "Memory",
                "Disk",
                "Wi-Fi",
                "Thunderbolt"
            ]
        );
        assert_eq!(tally(&checks), (10, 0, 2));
        let tailscale = checks.iter().find(|c| c.name == "Tailscale").unwrap();
        assert_eq!(tailscale.detail, "installed, not signed in yet");
        assert_eq!(checks[2].detail, "21 running, none failed");
    }

    #[test]
    fn failures_are_explained() {
        let (m, p) = setup(AGENT_BOX);
        let mut facts = healthy();
        facts.insert("state".into(), "degraded".into());
        facts.insert("failed".into(), "tailscaled.service".into());
        facts.insert("node".into(), "v20.19.2".into());
        facts.insert("pkg:git".into(), "".into());
        let checks = report(&m, &p, &seen(), &facts);
        let detail = |n: &str| checks.iter().find(|c| c.name == n).unwrap().clone();
        assert_eq!(detail("Services").status, Status::Fail);
        assert_eq!(
            detail("Services").detail,
            "1 service failed: tailscaled.service"
        );
        assert_eq!(
            detail("Node").detail,
            "v20.19.2, but muxtra.toml asks for Node 26"
        );
        assert_eq!(detail("Tools").detail, "missing: git");
        assert_eq!(tally(&checks).1, 3);
    }

    #[test]
    fn no_ssh_stops_early() {
        let (m, p) = setup(AGENT_BOX);
        let checks = report(
            &m,
            &p,
            &Observed {
                boot_seconds: Some(30),
                ssh: false,
                sftp: false,
            },
            &BTreeMap::new(),
        );
        assert_eq!(checks.len(), 2);
        assert_eq!(checks[1].status, Status::Fail);
    }

    #[test]
    fn probe_asks_about_what_the_manifest_wants() {
        let (m, _) = setup(AGENT_BOX);
        let script = probe_script(&m);
        assert!(script.contains("fact service:ssh \"$(systemctl is-active 'ssh'"));
        assert!(script.contains("fact service:tailscaled"));
        assert!(script.contains("pkg:git"));
        assert!(!script.contains("pkg:node"));
        assert!(script.contains("mosh-server"));
    }

    #[test]
    fn facts_parse_with_empty_values() {
        let f = parse_facts("failed\t\nstate\trunning\nnoise without a tab\n");
        assert_eq!(f.get("failed").map(String::as_str), Some(""));
        assert_eq!(f.get("state").map(String::as_str), Some("running"));
        assert_eq!(f.len(), 2);
    }
}

#[cfg(test)]
mod wifi_tests {
    use super::*;
    use crate::{Inputs, plan};

    #[test]
    fn iwd_not_running_fails_services() {
        let m = Manifest::parse(include_str!("../../../starters/agent-box.toml")).unwrap();
        let p = plan(
            &m,
            &Inputs {
                ssh_keys: vec!["ssh-ed25519 AAAA t".into()],
                ..Default::default()
            },
        )
        .unwrap();
        let facts = parse_facts(
            "state\trunning\nfailed\t\nrunning\t20\nservice:ssh\tactive\nservice:tailscaled\tactive\n\
             service:iwd\tinactive\nwifi-networks\t0\nslots\t4\nsudo\tnopass\n",
        );
        let seen = Observed {
            boot_seconds: Some(20),
            ssh: true,
            sftp: true,
        };
        let checks = report(&m, &p, &seen, &facts);
        let row = |n: &str| checks.iter().find(|c| c.name == n).unwrap().clone();
        assert_eq!(row("Services").detail, "not running: iwd");
        assert!(row("Wi-Fi").detail.contains("muxtra wifi add"));
        assert!(probe_script(&m).contains("service:iwd"));
    }
}
