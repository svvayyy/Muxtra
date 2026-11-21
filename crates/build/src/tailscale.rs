//! Reads what Tailscale says on a Mac running Muxtra: whether it is signed
//! in, and the sign-in link `tailscale login` prints. Pure text parsing,
//! so `muxtra tailscale login` stays easy to test.

use serde_json::Value;

/// Where Tailscale is on the Mac.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    /// Signed in and connected.
    SignedIn {
        /// The Mac's name on the tailnet, like `agent-box.example.ts.net`.
        name: String,
        /// Its Tailscale addresses, IPv4 first.
        ips: Vec<String>,
        /// Which tailnet it joined, so a wrong account is easy to spot.
        tailnet: String,
    },
    /// Signed in, but the tailnet admin has to approve the Mac first.
    NeedsApproval,
    /// Not signed in yet.
    NeedsLogin,
    /// Starting up, or a state this version of Muxtra does not know.
    Other(String),
}

/// Reads the output of `tailscale status --json`.
pub fn state(status_json: &str) -> Result<State, String> {
    let v: Value = serde_json::from_str(status_json)
        .map_err(|_| "Tailscale on the Mac gave an answer Muxtra could not read.".to_string())?;
    let backend = v["BackendState"].as_str().unwrap_or_default();
    Ok(match backend {
        "Running" => {
            let name = v["Self"]["DNSName"]
                .as_str()
                .unwrap_or_default()
                .trim_end_matches('.')
                .to_string();
            let mut ips: Vec<String> = v["TailscaleIPs"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|ip| ip.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            ips.sort_by_key(|ip| ip.contains(':'));
            let tailnet = v["CurrentTailnet"]["Name"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            State::SignedIn { name, ips, tailnet }
        }
        "NeedsMachineAuth" => State::NeedsApproval,
        "NeedsLogin" => State::NeedsLogin,
        other => State::Other(other.to_string()),
    })
}

/// The sign-in link in one line of `tailscale login` output, if it has one.
pub fn login_url(line: &str) -> Option<&str> {
    let url = line.trim();
    (url.starts_with("https://") && !url.contains(char::is_whitespace)).then_some(url)
}

/// The shell command that starts signing in on the Mac. It waits up to
/// `wait_secs` for someone to finish, printing the link first. A custom
/// control server (like Headscale), saved at build time, is used when set.
pub fn login_command(wait_secs: u64) -> String {
    format!(
        "server=$(cat /etc/muxtra/tailscale-server 2>/dev/null); \
         exec sudo -n tailscale login ${{server:+--login-server=\"$server\"}} --timeout={wait_secs}s 2>&1"
    )
}

/// The shell command that prints Tailscale's status, or `not-installed`.
pub const STATUS_COMMAND: &str =
    "command -v tailscale >/dev/null || { echo not-installed; exit 0; }; tailscale status --json";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_in_status_gives_name_and_ipv4_first() {
        let json = r#"{"BackendState":"Running","AuthURL":"",
            "TailscaleIPs":["fd7a:115c:a1e0::1","100.64.0.7"],
            "Self":{"HostName":"agent-box","DNSName":"agent-box.example.ts.net."},
            "CurrentTailnet":{"Name":"example.github"}}"#;
        assert_eq!(
            state(json).unwrap(),
            State::SignedIn {
                name: "agent-box.example.ts.net".into(),
                ips: vec!["100.64.0.7".into(), "fd7a:115c:a1e0::1".into()],
                tailnet: "example.github".into(),
            }
        );
    }

    #[test]
    fn other_states() {
        let fresh = r#"{"BackendState":"NeedsLogin","AuthURL":"","TailscaleIPs":null,
            "Self":{"DNSName":""}}"#;
        assert_eq!(state(fresh).unwrap(), State::NeedsLogin);
        assert_eq!(
            state(r#"{"BackendState":"NeedsMachineAuth"}"#).unwrap(),
            State::NeedsApproval
        );
        assert_eq!(
            state(r#"{"BackendState":"Starting"}"#).unwrap(),
            State::Other("Starting".into())
        );
        assert!(state("not-installed").is_err());
    }

    #[test]
    fn finds_the_link_in_login_output() {
        let out = "\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/0123abcd\n\n";
        let found: Vec<&str> = out.lines().filter_map(login_url).collect();
        assert_eq!(found, ["https://login.tailscale.com/a/0123abcd"]);
        assert_eq!(login_url("see https://example.com for help"), None);
    }

    #[test]
    fn login_command_uses_a_saved_server_and_never_asks_for_a_password() {
        let cmd = login_command(600);
        assert!(cmd.contains("/etc/muxtra/tailscale-server"));
        assert!(cmd.contains("sudo -n tailscale login"));
        assert!(cmd.contains("--timeout=600s"));
    }
}
