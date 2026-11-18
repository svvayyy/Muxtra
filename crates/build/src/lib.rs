//! Turns a manifest into what the hidden builder VM needs: a `config.sh`
//! with every setting, and cloud-init files that run `builder.sh` with it.
//!
//! Nothing here touches the disk, the network, or a VM. `muxtra build` in
//! the CLI does that. Keeping this part pure makes it easy to test.

use muxtra_manifest::{Manifest, Network, Remote};
use std::fmt;

pub mod check;

/// The script that runs inside the builder VM.
pub const BUILDER_SH: &str = include_str!("../assets/builder.sh");

/// Size of each system slot (A and B) on the disk image.
pub const ROOT_SIZE: &str = "4G";

/// Size of the whole disk image. The home partition gets whatever is left.
/// The file is sparse, so it only uses the space actually written.
pub const IMAGE_BYTES: u64 = 10 * 1024 * 1024 * 1024;

/// The Node.js major version `"node"` means: the current LTS.
pub const NODE_LTS: u32 = 26;

/// Oldest Node.js major version NodeSource still publishes.
pub const NODE_OLDEST: u32 = 20;

/// Packages every Muxtra system gets.
const BASE_PACKAGES: &[&str] = &[
    "systemd-sysv",
    "udev",
    "dbus",
    "kmod",
    "iproute2",
    "iputils-ping",
    "ca-certificates",
    "curl",
    "gnupg",
    "less",
    "nano",
    "sudo",
    "linux-image-amd64",
    "initramfs-tools",
    "systemd-resolved",
    "avahi-daemon",
    "libnss-mdns",
];

/// Everything the builder needs, ready to hand over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// Settings for builder.sh, as shell variables.
    pub config_sh: String,
    /// Debian packages installed in the first pass.
    pub packages: Vec<String>,
    /// Node.js major version, if Node is wanted.
    pub node_major: Option<u32>,
    /// What step 4 says it is adding, for people to read.
    pub modules_label: String,
}

/// Why a manifest cannot be built (yet).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanError(pub String);

impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PlanError {}

/// Things `muxtra build` works out before planning.
#[derive(Debug, Clone, Default)]
pub struct Inputs {
    /// Public SSH keys, one per entry, already read from disk.
    pub ssh_keys: Vec<String>,
    /// SHA-512 crypt hash from muxtra.secrets, when a password is set.
    pub password_hash: Option<String>,
}

/// Works out every setting for the builder.
pub fn plan(manifest: &Manifest, inputs: &Inputs) -> Result<Plan, PlanError> {
    let remote = &manifest.modules.remote;
    let network = &manifest.modules.network;
    let has = |r: Remote| remote.contains(&r);

    for r in remote {
        if matches!(
            r,
            Remote::Netbird | Remote::Zerotier | Remote::Cloudflared | Remote::Ngrok
        ) {
            return Err(PlanError(format!(
                "\"{}\" in modules.remote cannot be built yet. Remove it for now, or use \"tailscale\" or \"wireguard\".",
                remote_name(*r)
            )));
        }
    }
    if manifest.user.password && inputs.password_hash.is_none() {
        return Err(PlanError(
            "muxtra.toml says there is a password, but muxtra.secrets has none. Run `muxtra passwd` to set it again, or `muxtra passwd --remove`.".to_string(),
        ));
    }
    if has(Remote::Ssh) && inputs.ssh_keys.is_empty() {
        return Err(PlanError(
            "SSH is on but there are no keys to let you in.".to_string(),
        ));
    }

    let mut packages: Vec<String> = BASE_PACKAGES.iter().map(|p| p.to_string()).collect();
    let mut add = |p: &str| {
        if !packages.iter().any(|x| x == p) {
            packages.push(p.to_string());
        }
    };
    if network.contains(&Network::Wifi) {
        add("iwd");
        add("wireless-regdb");
    }
    if has(Remote::Ssh) {
        add("openssh-server");
    }
    if has(Remote::Mosh) {
        add("mosh");
    }
    if has(Remote::Wireguard) {
        add("wireguard-tools");
    }

    let mut node_major = None;
    for tool in &manifest.modules.tools {
        if let Some(major) = node_version(tool)? {
            node_major = Some(major);
        } else if is_package_name(tool) {
            add(tool);
        } else {
            return Err(PlanError(format!(
                "\"{tool}\" in modules.tools is not a Debian package name. Use names like \"git\", \"ripgrep\" or \"node@24\"."
            )));
        }
    }

    let start: Vec<String> = manifest
        .boot
        .start
        .iter()
        .map(|s| match s.as_str() {
            // Debian calls the OpenSSH server unit "ssh".
            "sshd" => "ssh".to_string(),
            other => other.to_string(),
        })
        .collect();

    let mut label: Vec<String> = remote.iter().map(|r| remote_name(*r).to_string()).collect();
    label.extend(manifest.modules.tools.iter().cloned());
    let modules_label = if label.is_empty() {
        "none".to_string()
    } else {
        label.join(", ")
    };

    let flag = |on: bool| if on { "1" } else { "0" };
    let tailscale_server = manifest
        .tailscale
        .as_ref()
        .and_then(|t| t.server.clone())
        .unwrap_or_default();

    let mut config =
        String::from("# Written by muxtra build from muxtra.toml. Read by builder.sh.\n");
    let mut var = |name: &str, value: &str| {
        config.push_str(&format!("{name}={}\n", quote(value)));
    };
    var("DEBIAN", &manifest.base.debian);
    var("HOST_NAME", &manifest.system.name);
    var("MAC_MODEL", &manifest.system.mac);
    var("USER_NAME", &manifest.user.name);
    var(
        "PASSWORD_HASH",
        inputs.password_hash.as_deref().unwrap_or(""),
    );
    var("SUDO_PASSWORD", flag(manifest.user.sudo_password));
    var("ROOT_SIZE", ROOT_SIZE);
    var(
        "NODE_MAJOR",
        &node_major.map(|m| m.to_string()).unwrap_or_default(),
    );
    var("WITH_SSH", flag(has(Remote::Ssh)));
    var("WITH_TAILSCALE", flag(has(Remote::Tailscale)));
    var("WITH_ETHERNET", flag(network.contains(&Network::Ethernet)));
    var(
        "WITH_THUNDERBOLT",
        flag(network.contains(&Network::Thunderbolt)),
    );
    var("TAILSCALE_SERVER", &tailscale_server);
    var("MODULE_LABEL", &modules_label);
    config.push_str(&format!("SSH_KEYS=({})\n", quote_list(&inputs.ssh_keys)));
    config.push_str(&format!("START=({})\n", quote_list(&start)));
    config.push_str(&format!("PACKAGES=({})\n", quote_list(&packages)));

    Ok(Plan {
        config_sh: config,
        packages,
        node_major,
        modules_label,
    })
}

/// Changes whenever a build would come out different: the settings, the
/// builder script, or the image size. `muxtra check` compares it with the
/// one saved next to the last image to know when to rebuild.
pub fn fingerprint(plan: &Plan) -> String {
    // FNV-1a, 64 bit. Only used to notice changes, not for security.
    let mut hash: u64 = 0xcbf29ce484222325;
    for part in [
        plan.config_sh.as_bytes(),
        BUILDER_SH.as_bytes(),
        &IMAGE_BYTES.to_le_bytes(),
    ] {
        for byte in part {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// `node` means the current LTS. `node@24` pins a major version.
fn node_version(tool: &str) -> Result<Option<u32>, PlanError> {
    if tool == "node" || tool == "nodejs" {
        return Ok(Some(NODE_LTS));
    }
    let Some(version) = tool.strip_prefix("node@") else {
        return Ok(None);
    };
    match version.parse::<u32>() {
        Ok(major) if (NODE_OLDEST..=NODE_LTS + 1).contains(&major) => Ok(Some(major)),
        _ => Err(PlanError(format!(
            "\"{tool}\" is not a Node.js version Muxtra can install. Use \"node\" for the current LTS ({NODE_LTS}), or a major version from {NODE_OLDEST} to {}, like \"node@24\".",
            NODE_LTS + 1
        ))),
    }
}

/// Debian package names: lowercase letters, digits, and `+ - .`, starting
/// with a letter or digit, at least two characters.
fn is_package_name(name: &str) -> bool {
    name.len() >= 2
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "+-.".contains(c))
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

/// Quotes a value for a POSIX shell: single quotes, with any single quote
/// inside written as '\''.
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn quote_list(items: &[String]) -> String {
    items.iter().map(|i| quote(i)).collect::<Vec<_>>().join(" ")
}

/// cloud-init `user-data` that writes both scripts and runs the build,
/// then powers the builder off. The result goes to the serial console as
/// `MUXTRA-RESULT <exit code>`.
pub fn user_data(config_sh: &str) -> String {
    format!(
        r#"#cloud-config
write_files:
  - path: /root/muxtra/builder.sh
    permissions: "0755"
    encoding: b64
    content: {}
  - path: /root/muxtra/config.sh
    permissions: "0600"
    encoding: b64
    content: {}
runcmd:
  - [bash, -c, "/root/muxtra/builder.sh 2>&1 | tee /dev/console; echo MUXTRA-RESULT ${{PIPESTATUS[0]}} > /dev/console; sync; poweroff"]
"#,
        base64(BUILDER_SH.as_bytes()),
        base64(config_sh.as_bytes())
    )
}

/// cloud-init `meta-data`. A fresh instance id makes cloud-init run every time.
pub fn meta_data(instance: &str) -> String {
    format!("instance-id: muxtra-build-{instance}\nlocal-hostname: muxtra-builder\n")
}

/// What the builder said on its serial console.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Progress {
    /// The latest step: (number, total, description).
    pub step: Option<(u32, u32, String)>,
    /// Exit code of builder.sh, once it finished.
    pub result: Option<i32>,
    /// Size of the finished system in MB.
    pub size_mb: Option<u64>,
}

/// Reads progress markers out of the builder's console log.
pub fn read_progress(console: &str) -> Progress {
    let mut progress = Progress::default();
    for line in console.lines() {
        let line = line.trim_end_matches('\r');
        // cloud-init also echoes lines with a "[ time] cloud-init[pid]: " prefix.
        let line = match line.find("MUXTRA-") {
            Some(at) => &line[at..],
            None => continue,
        };
        if let Some(rest) = line.strip_prefix("MUXTRA-STEP ") {
            let Some((counts, text)) = rest.split_once(' ') else {
                continue;
            };
            let Some((n, total)) = counts.split_once('/') else {
                continue;
            };
            if let (Ok(n), Ok(total)) = (n.parse(), total.parse()) {
                progress.step = Some((n, total, text.trim().to_string()));
            }
        } else if let Some(rest) = line.strip_prefix("MUXTRA-RESULT ") {
            progress.result = rest.trim().parse().ok();
        } else if let Some(rest) = line.strip_prefix("MUXTRA-SIZE ") {
            progress.size_mb = rest.trim().parse().ok();
        }
    }
    progress
}

/// Lines from a failed build worth showing a person: the builder's own
/// output, without boot noise or cloud-init prefixes, last ones first kept.
pub fn failure_excerpt(console: &str, max_lines: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut in_build = false;
    for raw in console.lines() {
        let line = raw.trim_end_matches('\r');
        let line = match line.find("]: ") {
            Some(at) if line.contains("cloud-init[") => &line[at + 3..],
            _ => line,
        };
        if line.contains("MUXTRA-STEP 1/") {
            in_build = true;
        }
        if !in_build || line.starts_with('[') || line.trim().is_empty() {
            continue;
        }
        if line.starts_with("MUXTRA-RESULT") {
            break;
        }
        if lines.last().map(String::as_str) != Some(line) {
            lines.push(line.to_string());
        }
    }
    let skip = lines.len().saturating_sub(max_lines);
    lines.split_off(skip)
}

/// Standard base64, for cloud-init `encoding: b64`.
pub fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT_BOX: &str = include_str!("../../../starters/agent-box.toml");
    const BLANK: &str = include_str!("../../../starters/blank.toml");
    const KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample test@example";

    fn inputs() -> Inputs {
        Inputs {
            ssh_keys: vec![KEY.to_string()],
            password_hash: None,
        }
    }

    fn manifest(text: &str) -> Manifest {
        Manifest::parse(text).expect("valid manifest")
    }

    #[test]
    fn agent_box_plan() {
        let p = plan(&manifest(AGENT_BOX), &inputs()).unwrap();
        assert_eq!(p.node_major, Some(NODE_LTS));
        for pkg in ["openssh-server", "mosh", "git", "iwd", "linux-image-amd64"] {
            assert!(p.packages.iter().any(|x| x == pkg), "missing {pkg}");
        }
        // Node comes from NodeSource, not as a Debian package.
        assert!(!p.packages.iter().any(|x| x == "node" || x == "nodejs"));
        assert!(p.config_sh.contains("HOST_NAME='agent-box'\n"));
        assert!(p.config_sh.contains("WITH_TAILSCALE='1'\n"));
        assert!(p.config_sh.contains("NODE_MAJOR='26'\n"));
        assert!(
            p.config_sh.contains("START=('ssh' 'tailscaled')\n"),
            "{}",
            p.config_sh
        );
        assert!(p.config_sh.contains(&format!("SSH_KEYS=('{KEY}')\n")));
        assert_eq!(p.modules_label, "ssh, mosh, tailscale, git, node");
    }

    #[test]
    fn blank_plan_is_small() {
        let p = plan(&manifest(BLANK), &inputs()).unwrap();
        assert_eq!(p.node_major, None);
        assert!(!p.packages.iter().any(|x| x == "mosh"));
        assert!(p.config_sh.contains("WITH_TAILSCALE='0'\n"));
        assert!(p.config_sh.contains("NODE_MAJOR=''\n"));
    }

    #[test]
    fn node_versions() {
        assert_eq!(node_version("node").unwrap(), Some(NODE_LTS));
        assert_eq!(node_version("node@24").unwrap(), Some(24));
        assert_eq!(node_version("git").unwrap(), None);
        assert!(node_version("node@12").is_err());
        assert!(node_version("node@latest").is_err());
    }

    #[test]
    fn tools_are_package_names() {
        let text = AGENT_BOX.replace(
            "tools   = [\"git\", \"node\"]",
            "tools   = [\"git\", \"ripgrep\", \"g++\"]",
        );
        let p = plan(&manifest(&text), &inputs()).unwrap();
        assert!(p.packages.iter().any(|x| x == "ripgrep"));
        assert!(p.packages.iter().any(|x| x == "g++"));
        let bad = AGENT_BOX.replace("\"git\", \"node\"", "\"git\", \"rm -rf /\"");
        let err = plan(&manifest(&bad), &inputs()).unwrap_err();
        assert!(err.0.contains("not a Debian package name"), "{err}");
    }

    #[test]
    fn unbuildable_modules_say_so() {
        let text = AGENT_BOX.replace("\"tailscale\"]", "\"tailscale\", \"netbird\"]");
        let err = plan(&manifest(&text), &inputs()).unwrap_err();
        assert!(
            err.0.contains("netbird") && err.0.contains("cannot be built yet"),
            "{err}"
        );
    }

    #[test]
    fn password_needs_a_hash() {
        let text = AGENT_BOX.replace("password = false", "password = true");
        let err = plan(&manifest(&text), &inputs()).unwrap_err();
        assert!(err.0.contains("muxtra passwd"), "{err}");
        let with_hash = Inputs {
            password_hash: Some("$6$salt$hash".into()),
            ..inputs()
        };
        let p = plan(&manifest(&text), &with_hash).unwrap();
        assert!(p.config_sh.contains("PASSWORD_HASH='$6$salt$hash'\n"));
    }

    #[test]
    fn fingerprint_follows_the_settings() {
        let a = plan(&manifest(AGENT_BOX), &inputs()).unwrap();
        let b = plan(&manifest(BLANK), &inputs()).unwrap();
        assert_eq!(fingerprint(&a), fingerprint(&a.clone()));
        assert_ne!(fingerprint(&a), fingerprint(&b));
        let other_key = Inputs {
            ssh_keys: vec!["ssh-ed25519 AAAA other".into()],
            ..inputs()
        };
        assert_ne!(
            fingerprint(&a),
            fingerprint(&plan(&manifest(AGENT_BOX), &other_key).unwrap())
        );
    }

    #[test]
    fn quoting_is_safe() {
        assert_eq!(quote("plain"), "'plain'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote("$(rm -rf /)"), "'$(rm -rf /)'");
    }

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn user_data_carries_both_scripts() {
        let ud = user_data("HOST_NAME='x'\n");
        assert!(ud.starts_with("#cloud-config\n"));
        assert!(ud.contains(&base64(BUILDER_SH.as_bytes())));
        assert!(ud.contains(&base64(b"HOST_NAME='x'\n")));
        assert!(ud.contains("MUXTRA-RESULT ${PIPESTATUS[0]}"));
    }

    #[test]
    fn progress_from_console() {
        let log = "boot noise\r\n\
            MUXTRA-STEP 1/7 Preparing the builder\r\n\
            [   43.8] cloud-init[593]: MUXTRA-STEP 3/7 Installing Debian trixie\r\n\
            MUXTRA-SIZE 1008\r\n\
            MUXTRA-RESULT 0\r\n";
        let p = read_progress(log);
        assert_eq!(p.step, Some((3, 7, "Installing Debian trixie".to_string())));
        assert_eq!(p.size_mb, Some(1008));
        assert_eq!(p.result, Some(0));
        assert_eq!(read_progress("nothing yet").result, None);
    }

    #[test]
    fn failure_excerpt_skips_noise() {
        let log = "[    1.0] kernel stuff\n\
            MUXTRA-STEP 1/7 Preparing the builder\n\
            [   46.2] cloud-init[593]: MUXTRA-STEP 1/7 Preparing the builder\n\
            [   47.0] EXT4-fs (vda2): unmounting\n\
            cp: not writing through dangling symlink\n\
            MUXTRA-RESULT 1\n\
            after the end\n";
        let lines = failure_excerpt(log, 10);
        assert_eq!(
            lines,
            [
                "MUXTRA-STEP 1/7 Preparing the builder",
                "cp: not writing through dangling symlink"
            ]
        );
    }

    #[test]
    fn builder_script_markers_match_the_reader() {
        // The CLI reads these markers. Changing them in one place breaks the other.
        assert!(BUILDER_SH.contains("echo \"MUXTRA-STEP $1/$TOTAL_STEPS $2\""));
        assert!(BUILDER_SH.contains("echo \"MUXTRA-SIZE"));
        for var in [
            "DEBIAN",
            "HOST_NAME",
            "USER_NAME",
            "PASSWORD_HASH",
            "SUDO_PASSWORD",
            "ROOT_SIZE",
            "NODE_MAJOR",
            "WITH_SSH",
            "WITH_TAILSCALE",
            "WITH_ETHERNET",
            "WITH_THUNDERBOLT",
            "TAILSCALE_SERVER",
            "MODULE_LABEL",
            "SSH_KEYS",
            "START",
            "PACKAGES",
        ] {
            assert!(
                BUILDER_SH.contains(&format!("${var}"))
                    || BUILDER_SH.contains(&format!("${{{var}")),
                "builder.sh never reads {var}"
            );
        }
    }
}
