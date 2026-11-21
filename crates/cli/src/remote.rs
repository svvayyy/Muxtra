//! Reaching a real Mac running Muxtra over SSH, for `muxtra check --real`
//! and `muxtra tailscale login`.

use crate::Failure;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// How to reach the Mac over SSH.
pub struct Mac {
    /// What the person passed with --host, or `<name>.local`.
    pub target: String,
    pub user: String,
    pub identities: Vec<PathBuf>,
}

impl Mac {
    pub fn new(host: Option<String>, name: &str, user: &str, identities: Vec<PathBuf>) -> Mac {
        Mac {
            target: host.unwrap_or_else(|| format!("{name}.local")),
            user: user.to_string(),
            identities,
        }
    }

    /// Options for ssh and sftp, without the destination.
    pub fn options(&self) -> Vec<String> {
        let mut args: Vec<String> = [
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "LogLevel=ERROR",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        for id in &self.identities {
            args.push("-i".to_string());
            args.push(id.display().to_string());
        }
        args
    }

    /// `user@host`, unless --host already named a user.
    pub fn destination(&self) -> String {
        if self.target.contains('@') {
            self.target.clone()
        } else {
            format!("{}@{}", self.user, self.target)
        }
    }

    /// Options and destination for ssh.
    pub fn ssh_args(&self) -> Vec<String> {
        let mut args = self.options();
        args.push(self.destination());
        args
    }

    /// Runs a command on the Mac. Returns its output, or a plain-English
    /// reason it could not.
    pub fn run(&self, command: &str, stdin: Option<&str>) -> Result<String, Failure> {
        let mut child = Command::new("ssh")
            .args(self.ssh_args())
            .arg(command)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| Failure("Could not run ssh on this Mac.".to_string()))?;
        if let Some(input) = stdin
            && let Some(mut pipe) = child.stdin.take()
        {
            let _ = pipe.write_all(input.as_bytes());
        }
        let out = child.wait_with_output()?;
        if out.status.code() == Some(255) {
            return Err(Failure(self.problem(&String::from_utf8_lossy(&out.stderr))));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Opens an SFTP session and lists the home folder.
    pub fn sftp_works(&self) -> bool {
        let Ok(mut child) = Command::new("sftp")
            .args(["-b", "-"])
            .args(self.options())
            .arg(self.destination())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return false;
        };
        if let Some(mut input) = child.stdin.take() {
            let _ = input.write_all(b"pwd\nls\n");
        }
        child.wait().is_ok_and(|s| s.success())
    }

    /// A plain-English reason SSH failed, with what to do next.
    pub fn problem(&self, stderr: &str) -> String {
        let target = &self.target;
        if stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
            || stderr.contains("Host key verification failed")
        {
            format!(
                "{target} has a new SSH identity, which is normal after putting Muxtra on it again. Forget the old one with `ssh-keygen -R {target}`, then try again."
            )
        } else if stderr.contains("Permission denied") {
            format!(
                "{target} did not accept your SSH key. It only accepts the keys in muxtra.toml from when it was built."
            )
        } else {
            format!(
                "Could not reach {target}. Make sure it is on, running Muxtra, and on the same network as this Mac. If it is somewhere else, pass its address with --host."
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_target_and_destination() {
        let mac = Mac::new(None, "agent-box", "me", vec!["/k/id_ed25519".into()]);
        assert_eq!(mac.target, "agent-box.local");
        assert_eq!(mac.destination(), "me@agent-box.local");
        assert!(
            mac.options()
                .ends_with(&["-i".into(), "/k/id_ed25519".into()])
        );
        let other = Mac::new(Some("admin@10.0.0.5".into()), "agent-box", "me", vec![]);
        assert_eq!(other.destination(), "admin@10.0.0.5");
    }

    #[test]
    fn problems_say_what_to_do() {
        let mac = Mac::new(None, "agent-box", "me", vec![]);
        assert!(
            mac.problem("Host key verification failed.")
                .contains("ssh-keygen -R agent-box.local")
        );
        assert!(
            mac.problem("me@agent-box.local: Permission denied (publickey).")
                .contains("SSH key")
        );
        assert!(
            mac.problem("ssh: connect to host agent-box.local port 22: Operation timed out")
                .contains("--host")
        );
    }
}
