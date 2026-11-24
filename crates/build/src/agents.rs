//! Reads what Claude Code and Codex say on a Mac running Muxtra: whether
//! they are installed and signed in, and the sign-in link and code their
//! login commands print. Pure text handling, so the login command is
//! testable without a Mac.

use muxtra_manifest::Agent;
use serde_json::Value;

/// Where an agent is on the Mac.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    NotInstalled,
    SignedOut,
    /// Signed in, with the account when the agent says which.
    SignedIn(Option<String>),
}

/// Both installers put their command in ~/.local/bin, which commands run
/// over SSH do not search.
const PATH: &str = "PATH=\"$HOME/.local/bin:$PATH\"";

/// The shell command that prints the agent's sign-in status, or
/// `not-installed`.
pub fn status_command(agent: Agent) -> String {
    let cmd = agent.command();
    let ask = match agent {
        Agent::ClaudeCode => "claude auth status --json 2>/dev/null",
        Agent::Codex => "codex login status 2>&1; echo \"exit=$?\"",
    };
    format!("{PATH}; command -v {cmd} >/dev/null || {{ echo not-installed; exit 0; }}; {ask}")
}

/// The shell command that starts signing in, in the mode that works with no
/// browser on the Mac.
pub fn login_command(agent: Agent) -> String {
    let login = match agent {
        // Prints a link, then reads the code the sign-in page shows.
        Agent::ClaudeCode => "claude auth login --claudeai",
        // Prints a link and a one-time code to enter there.
        Agent::Codex => "codex login --device-auth",
    };
    format!("{PATH}; exec {login} 2>&1")
}

/// Reads the output of `status_command`.
pub fn state(agent: Agent, output: &str) -> State {
    let out = output.trim();
    if out == "not-installed" {
        return State::NotInstalled;
    }
    match agent {
        Agent::ClaudeCode => {
            let Ok(v) = serde_json::from_str::<Value>(out) else {
                return State::SignedOut;
            };
            if v["loggedIn"].as_bool() != Some(true) {
                return State::SignedOut;
            }
            let account = ["email", "emailAddress"]
                .iter()
                .find_map(|k| v[*k].as_str().or_else(|| v["account"][*k].as_str()))
                .map(str::to_string);
            State::SignedIn(account)
        }
        Agent::Codex => {
            if out.ends_with("exit=0") && out.contains("Logged in") {
                State::SignedIn(None)
            } else {
                State::SignedOut
            }
        }
    }
}

/// Text without terminal color codes.
pub fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// A sign-in link on its own in a line of output.
pub fn link(line: &str) -> Option<String> {
    let line = plain(line);
    let start = line.find("https://")?;
    let url = line[start..].split_whitespace().next()?;
    Some(url.to_string())
}

/// Codex's one-time code, like `ABCD-12345`, alone on its line.
pub fn device_code(line: &str) -> Option<String> {
    let line = plain(line);
    let code = line.trim();
    let (a, b) = code.split_once('-')?;
    let ok = |s: &str| {
        (4..=6).contains(&s.len())
            && s.chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    };
    (ok(a) && ok(b)).then(|| code.to_string())
}

/// Claude Code is asking for the code from the sign-in page.
pub fn wants_code(text: &str) -> bool {
    plain(text).contains("Paste code here")
}

/// Claude Code turned down the code that was pasted.
pub fn code_rejected(text: &str) -> bool {
    let t = plain(text).to_lowercase();
    t.contains("doesn't look like") || t.contains("invalid") || t.contains("expired")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_status() {
        let out = r#"{"loggedIn": false, "authMethod": "none"}"#;
        assert_eq!(state(Agent::ClaudeCode, out), State::SignedOut);
        let out = r#"{"loggedIn": true, "authMethod": "claude.ai", "email": "a@example.com"}"#;
        assert_eq!(
            state(Agent::ClaudeCode, out),
            State::SignedIn(Some("a@example.com".into()))
        );
        assert_eq!(
            state(Agent::ClaudeCode, "not-installed\n"),
            State::NotInstalled
        );
    }

    #[test]
    fn codex_status() {
        assert_eq!(
            state(Agent::Codex, "Not logged in\nexit=1"),
            State::SignedOut
        );
        assert_eq!(
            state(Agent::Codex, "Logged in using ChatGPT\nexit=0"),
            State::SignedIn(None)
        );
    }

    #[test]
    fn finds_the_link_and_code_in_real_output() {
        let codex = "1. Open this link in your browser and sign in to your account\n   \u{1b}[94mhttps://auth.openai.com/codex/device\u{1b}[0m\n\n2. Enter this one-time code \u{1b}[90m(expires in 15 minutes)\u{1b}[0m\n   \u{1b}[94m0P1A-18IHB\u{1b}[0m\n";
        let links: Vec<String> = codex.lines().filter_map(link).collect();
        let codes: Vec<String> = codex.lines().filter_map(device_code).collect();
        assert_eq!(links, ["https://auth.openai.com/codex/device"]);
        assert_eq!(codes, ["0P1A-18IHB"]);
        let claude = "If the browser didn't open, visit:\nhttps://claude.ai/oauth/authorize?code=true&client_id=x\nPaste code here if prompted > ";
        assert_eq!(
            claude.lines().find_map(link).as_deref(),
            Some("https://claude.ai/oauth/authorize?code=true&client_id=x")
        );
        assert!(wants_code(claude));
        assert!(code_rejected(
            "Paste code here if prompted > That doesn't look like the full code."
        ));
        assert_eq!(device_code("2. Enter this one-time code"), None);
    }

    #[test]
    fn commands_search_the_users_bin_folder() {
        for agent in [Agent::ClaudeCode, Agent::Codex] {
            assert!(status_command(agent).contains("$HOME/.local/bin"));
            assert!(login_command(agent).contains("$HOME/.local/bin"));
        }
        assert!(login_command(Agent::Codex).contains("--device-auth"));
    }
}
