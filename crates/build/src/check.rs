//! What `muxtra check` asks a booted system, and how it turns the answers
//! into a plain-English report.
//!
//! The probe script runs over SSH, inside the VM or on a real Mac, and
//! prints one `key<TAB>value` line per fact. Everything here is pure, so it
//! is tested without either.

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
    /// Ready, but something has to be plugged in or saved to test it.
    Untested,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Pass => "pass",
            Status::Fail => "fail",
            Status::RealMac => "needs-real-mac",
            Status::Untested => "untested",
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

/// The script `muxtra check` runs over SSH, in the VM or on a real Mac.
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
         fact memtotal \"$(free -m | awk '/^Mem:/{print $2}')\"\n\
         fact disk \"$(df -m / | awk 'NR==2{print $3}')\"\n\
         fact parts \"$(lsblk -no PARTLABEL 2>/dev/null | grep '^muxtra-' | paste -sd, -)\"\n\
         fact uptime \"$(cut -d. -f1 /proc/uptime)\"\n\
         fact model \"$(cat /sys/class/dmi/id/product_name 2>/dev/null)\"\n\
         timeout 5 bash -c '</dev/tcp/deb.debian.org/443' 2>/dev/null && fact internet yes\n\
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
             fact wifi-networks \"$(sudo -n sh -c 'ls /var/lib/iwd/*.psk 2>/dev/null | wc -l' 2>/dev/null)\"\n\
             wl=$(for d in /sys/class/net/*/wireless; do [ -d \"$d\" ] && basename \"$(dirname \"$d\")\"; done | head -1)\n\
             fact wifi-iface \"$wl\"\n\
             if [ -n \"$wl\" ]; then\n\
               fact wifi-ssid \"$(iwctl station \"$wl\" show 2>/dev/null | sed 's/\\x1b\\[[0-9;]*m//g' | sed -n 's/^ *Connected network  *//p')\"\n\
               sig=$(awk -v i=\"$wl:\" '$1==i{print int($4)}' /proc/net/wireless)\n\
               # Some drivers (like Broadcom's wl) leave that table empty. Ask iwd.\n\
               [ -n \"$sig\" ] && [ \"$sig\" != 0 ] || sig=$(iwctl station \"$wl\" show 2>/dev/null | sed 's/\\x1b\\[[0-9;]*m//g' | sed -n 's/^ *RSSI  *\\(-[0-9]*\\) dBm.*/\\1/p')\n\
               fact wifi-signal \"$sig\"\n\
             fi\n",
        );
    }
    if manifest.modules.network.contains(&Network::Thunderbolt) {
        s.push_str(
            "fact tb-domains \"$(ls /sys/bus/thunderbolt/devices 2>/dev/null | grep -c '^domain')\"\n\
             fact tb-net \"$(ls /sys/class/net | grep -m1 '^thunderbolt')\"\n\
             PATH=\"$PATH:/usr/sbin:/sbin\" modinfo -n thunderbolt_net >/dev/null 2>&1 && fact tb-driver yes\n",
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
    /// Checking a real Mac instead of the VM.
    pub real: bool,
}

/// "37 min", "2 h 5 min" or "3 days".
fn running_for(secs: u64) -> String {
    match secs {
        s if s < 3600 => format!("{} min", (s / 60).max(1)),
        s if s < 86400 => format!("{} h {} min", s / 3600, s % 3600 / 60),
        s if s < 2 * 86400 => "1 day".to_string(),
        s => format!("{} days", s / 86400),
    }
}

/// A Wi-Fi signal level in plain words.
fn signal_words(dbm: i64) -> &'static str {
    match dbm {
        d if d >= -60 => "strong",
        d if d >= -70 => "okay",
        _ => "weak",
    }
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

    if seen.real {
        // Reached over SSH, so it booted. Say how long ago.
        let up = fact("uptime").parse::<u64>().ok();
        out.push(Check::new(
            "Boots",
            Status::Pass,
            up.map_or("running".to_string(), |s| {
                format!("running for {}", running_for(s))
            }),
        ));
    } else {
        out.push(match seen.boot_seconds {
            Some(s) => Check::new("Boots", Status::Pass, format!("login in {s}s")),
            None => Check::new("Boots", Status::Fail, "never reached the login prompt"),
        });
    }

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

    if seen.real {
        let model = fact("model");
        let wanted = &manifest.system.mac;
        out.push(if model == wanted {
            Check::new("Mac model", Status::Pass, model)
        } else {
            Check::new(
                "Mac model",
                Status::Fail,
                format!("this is a {model}, but muxtra.toml is for a {wanted}. Drivers are picked per model, so set system.mac and build again"),
            )
        });
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

    out.push(if fact("internet") == "yes" {
        Check::new("Internet", Status::Pass, "reaches the Debian servers")
    } else {
        Check::new("Internet", Status::Fail, "cannot reach the internet")
    });

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
            (false, _) if seen.real => Check::new(
                "Tailscale",
                Status::Pass,
                "installed, not signed in yet. Run `muxtra tailscale login`",
            ),
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
        let total = fact("memtotal")
            .parse::<f64>()
            .map(|mb| format!(" of {:.1} GB", mb / 1024.0))
            .unwrap_or_default();
        let when = if seen.real { "" } else { " at idle" };
        out.push(Check::new(
            "Memory",
            Status::Pass,
            format!("{memory} MB used{total}{when}"),
        ));
    }
    let parts: Vec<&str> = fact("parts").split(',').collect();
    let has_part = |p: &str| parts.contains(&p);
    let disk = fact("disk")
        .parse::<f64>()
        .map(|mb| format!("{:.1} GB used", mb / 1024.0))
        .unwrap_or_default();
    out.push(
        if !["muxtra-efi", "muxtra-root-a", "muxtra-home"]
            .iter()
            .all(|p| has_part(p))
        {
            Check::new(
                "Disk",
                Status::Fail,
                "the Muxtra partitions are not all there",
            )
        } else if has_part("muxtra-root-b") {
            Check::new("Disk", Status::Pass, format!("{disk}, slots A and B ready"))
        } else {
            Check::new(
                "Disk",
                Status::Pass,
                format!("{disk}, slot A only (this drive has no room for B)"),
            )
        },
    );

    let network = &manifest.modules.network;
    if network.contains(&Network::Wifi) {
        let saved: usize = fact("wifi-networks").parse().unwrap_or(0);
        let detail = match saved {
            0 => "no networks saved yet. Run `muxtra wifi add`, then build again".to_string(),
            1 => "1 network saved. It joins on a real Mac".to_string(),
            n => format!("{n} networks saved. They join on a real Mac"),
        };
        out.push(if !seen.real {
            Check::new("Wi-Fi", Status::RealMac, detail)
        } else if fact("wifi-iface").is_empty() {
            Check::new(
                "Wi-Fi",
                Status::Fail,
                "no Wi-Fi hardware found. The driver or firmware for this Mac's Wi-Fi is missing",
            )
        } else if !fact("wifi-ssid").is_empty() {
            let signal = fact("wifi-signal")
                .parse::<i64>()
                .map(|d| format!(", {} signal ({d} dBm)", signal_words(d)))
                .unwrap_or_default();
            Check::new(
                "Wi-Fi",
                Status::Pass,
                format!("connected to {}{signal}", fact("wifi-ssid")),
            )
        } else if saved == 0 {
            Check::new("Wi-Fi", Status::Untested, detail)
        } else {
            Check::new(
                "Wi-Fi",
                Status::Fail,
                "not connected to any saved network. Is one in range?",
            )
        });
    }
    if network.contains(&Network::Thunderbolt) {
        let tb_net = fact("tb-net");
        out.push(if !seen.real {
            Check::new(
                "Thunderbolt",
                Status::RealMac,
                "can't be tested in a VM, needs a real Mac",
            )
        } else if !tb_net.is_empty() {
            Check::new(
                "Thunderbolt",
                Status::Pass,
                format!("cable connected ({tb_net})"),
            )
        } else if fact("tb-driver") != "yes" {
            Check::new(
                "Thunderbolt",
                Status::Fail,
                "the Thunderbolt networking driver is missing",
            )
        } else if fact("tb-domains").parse::<u32>().unwrap_or(0) == 0 {
            Check::new(
                "Thunderbolt",
                Status::Fail,
                "no Thunderbolt controller found",
            )
        } else {
            Check::new(
                "Thunderbolt",
                Status::Untested,
                "ready. Plug in a Thunderbolt cable to another Mac to test it",
            )
        });
    }
    out
}

/// Counts for the summary line: (passed, failed, need a real Mac, untested).
pub fn tally(checks: &[Check]) -> (usize, usize, usize, usize) {
    let count = |s: Status| checks.iter().filter(|c| c.status == s).count();
    (
        count(Status::Pass),
        count(Status::Fail),
        count(Status::RealMac),
        count(Status::Untested),
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
                ..Default::default()
            },
        )
        .unwrap();
        (m, p)
    }

    fn healthy() -> BTreeMap<String, String> {
        parse_facts(
            "state\trunning\nfailed\t\nrunning\t21\nhostname\tagent-box\nmemory\t239\ndisk\t1100\n\
             parts\tmuxtra-efi,muxtra-root-a,muxtra-root-b,muxtra-home\nsudo\tnopass\nservice:ssh\tactive\nservice:tailscaled\tactive\nnode\tv26.13.1\n\
             tailscale\t1.104.7\ntailscale-state\tNeedsLogin\nmosh\tyes\npkg:git\tinstall ok installed\n\
             service:iwd\tactive\nwifi-networks\t1\ninternet\tyes\nmemtotal\t1967\n",
        )
    }

    fn seen() -> Observed {
        Observed {
            boot_seconds: Some(24),
            ssh: true,
            sftp: true,
            real: false,
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
                "Internet",
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
        assert_eq!(tally(&checks), (11, 0, 2, 0));
        let memory = checks.iter().find(|c| c.name == "Memory").unwrap();
        assert_eq!(memory.detail, "239 MB used of 1.9 GB at idle");
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

    fn real_mac() -> BTreeMap<String, String> {
        let mut f = healthy();
        for (k, v) in [
            ("uptime", "2220"),
            ("model", "MacBookPro13,3"),
            ("parts", "muxtra-efi,muxtra-root-a,muxtra-home"),
            ("wifi-iface", "wlan0"),
            ("wifi-ssid", "Example Net"),
            ("wifi-signal", "-75"),
            ("tb-domains", "2"),
            ("tb-net", ""),
            ("tb-driver", "yes"),
        ] {
            f.insert(k.into(), v.into());
        }
        f
    }

    fn real_seen() -> Observed {
        Observed {
            boot_seconds: None,
            ssh: true,
            sftp: true,
            real: true,
        }
    }

    #[test]
    fn real_mac_report() {
        let (m, p) = setup(&AGENT_BOX.replace("iMac14,4", "MacBookPro13,3"));
        let checks = report(&m, &p, &real_seen(), &real_mac());
        let row = |n: &str| checks.iter().find(|c| c.name == n).unwrap().clone();
        assert_eq!(row("Boots").detail, "running for 37 min");
        assert_eq!(row("Mac model").status, Status::Pass);
        assert_eq!(
            row("Wi-Fi").detail,
            "connected to Example Net, weak signal (-75 dBm)"
        );
        assert_eq!(row("Thunderbolt").status, Status::Untested);
        assert_eq!(
            row("Disk").detail,
            "1.1 GB used, slot A only (this drive has no room for B)"
        );
        assert!(row("Tailscale").detail.contains("muxtra tailscale login"));
        assert_eq!(tally(&checks), (13, 0, 0, 1));
    }

    #[test]
    fn real_mac_problems() {
        let (m, p) = setup(AGENT_BOX);
        let mut facts = real_mac();
        facts.insert("wifi-ssid".into(), "".into());
        facts.insert("tb-domains".into(), "0".into());
        facts.remove("internet");
        let checks = report(&m, &p, &real_seen(), &facts);
        let row = |n: &str| checks.iter().find(|c| c.name == n).unwrap().clone();
        assert!(row("Mac model").detail.contains("muxtra.toml is for a"));
        assert!(row("Wi-Fi").detail.starts_with("not connected"));
        assert_eq!(row("Thunderbolt").detail, "no Thunderbolt controller found");
        assert_eq!(row("Internet").status, Status::Fail);
        assert_eq!(tally(&checks).1, 4);
        assert_eq!(running_for(7500), "2 h 5 min");
    }

    #[test]
    fn a_drive_without_room_for_slot_b_still_passes() {
        let (m, p) = setup(AGENT_BOX);
        let mut facts = healthy();
        facts.insert(
            "parts".into(),
            "muxtra-efi,muxtra-root-a,muxtra-home".into(),
        );
        let disk = |facts: &BTreeMap<String, String>| {
            report(&m, &p, &seen(), facts)
                .into_iter()
                .find(|c| c.name == "Disk")
                .unwrap()
        };
        assert_eq!(disk(&facts).status, Status::Pass);
        assert!(
            disk(&facts)
                .detail
                .ends_with("slot A only (this drive has no room for B)")
        );
        facts.insert("parts".into(), "muxtra-efi,muxtra-home".into());
        assert_eq!(disk(&facts).status, Status::Fail);
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
                real: false,
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
        assert!(
            script.contains("RSSI"),
            "falls back to iwd for the Wi-Fi signal"
        );
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
             service:iwd\tinactive\nwifi-networks\t0\nparts\tmuxtra-efi,muxtra-root-a,muxtra-root-b,muxtra-home\nsudo\tnopass\n",
        );
        let seen = Observed {
            boot_seconds: Some(20),
            ssh: true,
            sftp: true,
            real: false,
        };
        let checks = report(&m, &p, &seen, &facts);
        let row = |n: &str| checks.iter().find(|c| c.name == n).unwrap().clone();
        assert_eq!(row("Services").detail, "not running: iwd");
        assert!(row("Wi-Fi").detail.contains("muxtra wifi add"));
        assert!(probe_script(&m).contains("service:iwd"));
    }
}
