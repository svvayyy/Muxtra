//! `muxtra claude login` and `muxtra codex login`: sign a coding agent on
//! a Mac running Muxtra in to your account.
//!
//! It connects to the Mac over SSH and starts the agent's own sign-in, in
//! the mode made for machines without a browser. You open the link it
//! shows. Codex gives a one-time code to enter there. Claude shows a code
//! on the page that you paste back here. No API keys are created or stored.

use crate::remote::Mac;
use crate::style::{self, Role, say};
use crate::{Failure, files, keys, prompt};
use clap::{Args, Subcommand};
use muxtra_build::agents::{self, State};
use muxtra_manifest::{Agent, Remote};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

#[derive(Args)]
pub struct AgentArgs {
    #[command(subcommand)]
    action: AgentAction,
    /// Path to muxtra.toml, or the folder that holds it
    #[arg(long, default_value = ".", global = true)]
    manifest: PathBuf,
}

#[derive(Subcommand)]
enum AgentAction {
    /// Sign the Mac in to your account with a link you open in your browser
    Login(LoginArgs),
}

#[derive(Args)]
struct LoginArgs {
    /// Where to reach the Mac, like an IP address (default: <name>.local)
    #[arg(long)]
    host: Option<String>,
}

pub fn run(agent: Agent, args: AgentArgs) -> Result<(), Failure> {
    match args.action {
        AgentAction::Login(login) => run_login(agent, &args.manifest, login),
    }
}

fn run_login(agent: Agent, manifest: &std::path::Path, args: LoginArgs) -> Result<(), Failure> {
    let (_, manifest) = files::load_manifest(manifest)?;
    let name = manifest.system.name.clone();
    let id = agent.id();
    if !manifest.modules.agents.contains(&agent) {
        return Err(Failure(format!(
            "muxtra.toml has no \"{id}\" in modules.agents, so {name} does not have {}. Add it, then `muxtra build` and `muxtra poof` again.",
            agent.name()
        )));
    }
    if !manifest.modules.remote.contains(&Remote::Ssh) {
        return Err(Failure(format!(
            "Signing in happens over SSH, and muxtra.toml has no \"ssh\" in modules.remote. Run `{} login` on the Mac itself instead.",
            agent.command()
        )));
    }
    let mac = Mac::new(
        args.host,
        &name,
        &manifest.user.name,
        keys::resolve(&manifest.user.ssh_keys)?.identities,
    );
    say(&style::progress().paint(Role::Dim, &format!("Connecting to {}...", mac.target)));

    match agents::state(agent, &mac.run(&agents::status_command(agent), None)?) {
        State::NotInstalled => {
            return Err(Failure(format!(
                "{} is not installed on {name}. The image was built before \"{id}\" was in muxtra.toml: run `muxtra build` and `muxtra poof` again.",
                agent.name()
            )));
        }
        State::SignedIn(account) => return report(agent, &name, account),
        State::SignedOut => {}
    }

    let mut child = Command::new("ssh")
        .args(mac.options())
        .args(["-o", "ServerAliveInterval=15"])
        .arg(mac.destination())
        .arg(agents::login_command(agent))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| Failure("Could not run ssh on this Mac.".to_string()))?;
    let mut input = child.stdin.take().expect("stdin is piped");
    let output = Output::start(child.stdout.take().expect("stdout is piped"));

    let o = style::out();
    let mut said = Vec::new();
    let mut link = None;
    let mut code = None;
    let mut answered = false;
    loop {
        match output.next() {
            Event::Line(line) => {
                if link.is_none()
                    && let Some(url) = agents::link(&line)
                {
                    link = Some(url.clone());
                    match agent {
                        Agent::ClaudeCode => {
                            println!(
                                "Open this link and sign in to Claude:\n\n  {}\n",
                                o.paint(Role::Value, &url)
                            );
                            println!(
                                "{}",
                                o.paint(
                                    Role::Dim,
                                    "After you sign in, the page shows a code. Copy it and paste it here."
                                )
                            );
                        }
                        Agent::Codex => {}
                    }
                    continue;
                }
                if agent == Agent::Codex
                    && code.is_none()
                    && let Some(c) = agents::device_code(&line)
                {
                    code = Some(c.clone());
                    println!(
                        "Open this link, sign in to ChatGPT, and enter the code:\n\n  {}\n  Code: {}\n",
                        o.paint(
                            Role::Value,
                            link.as_deref()
                                .unwrap_or("https://auth.openai.com/codex/device")
                        ),
                        o.paint(Role::Value, &c)
                    );
                    say(&style::progress().paint(
                        Role::Dim,
                        "Waiting for you to finish. The code works for 15 minutes.",
                    ));
                    continue;
                }
                if agents::code_rejected(&line) {
                    let reason = agents::plain(&line);
                    let reason = reason.rsplit('>').next().unwrap_or("").trim();
                    println!("{} {}", o.paint(Role::Warn, "!"), reason);
                    answered = false;
                    continue;
                }
                if agents::wants_code(&line) {
                    answered = false;
                }
                let text = agents::plain(&line).trim().to_string();
                if !text.is_empty() {
                    said.push(text);
                }
            }
            Event::Waiting(pending) => {
                if agent == Agent::ClaudeCode && !answered && agents::wants_code(&pending) {
                    let pasted = prompt::ask("Code", None).map_err(|_| {
                        println!();
                        let _ = child.kill();
                        Failure("No code was given, so Claude Code is not signed in. Run `muxtra claude login` again.".to_string())
                    })?;
                    writeln!(input, "{}", pasted.trim())?;
                    input.flush()?;
                    answered = true;
                }
            }
            Event::End => break,
        }
    }
    let status = child.wait()?;
    if link.is_none() && !status.success() && status.code() == Some(255) {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut err);
        }
        return Err(Failure(mac.problem(&err)));
    }

    match agents::state(agent, &mac.run(&agents::status_command(agent), None)?) {
        State::SignedIn(account) => report(agent, &name, account),
        _ => {
            let tail: Vec<&str> = said
                .iter()
                .rev()
                .take(3)
                .rev()
                .map(String::as_str)
                .collect();
            let mut message = format!("{} on {name} is not signed in.", agent.name());
            if !tail.is_empty() {
                message.push_str(&format!(" It said: {}", tail.join(" ")));
            }
            if agent == Agent::Codex {
                message.push_str(" If the code was not accepted, turn on device code sign-in in your ChatGPT security settings, then try again.");
            }
            Err(Failure(message))
        }
    }
}

fn report(agent: Agent, name: &str, account: Option<String>) -> Result<(), Failure> {
    let o = style::out();
    let who = account
        .map(|a| format!(" as {}", o.paint(Role::Value, &a)))
        .unwrap_or_default();
    println!(
        "{} {} on {} is signed in{who}.",
        o.paint(Role::Ok, "✓"),
        agent.name(),
        o.paint(Role::Value, name)
    );
    println!(
        "{}",
        o.rich(
            Role::Dim,
            &format!("Start it with `ssh -t {name} {}`.", agent.command())
        )
    );
    Ok(())
}

/// What the agent printed so far.
enum Event {
    /// A whole line.
    Line(String),
    /// Output stopped mid-line, like at a question. The text so far.
    Waiting(String),
    /// The agent finished.
    End,
}

/// Reads the agent's output on a thread, so a question that does not end
/// in a new line (like "Paste code here >") is still seen.
struct Output {
    chunks: mpsc::Receiver<Vec<u8>>,
    pending: std::cell::RefCell<Vec<u8>>,
    lines: std::cell::RefCell<std::collections::VecDeque<String>>,
}

impl Output {
    fn start(mut from: impl Read + Send + 'static) -> Output {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = from.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        Output {
            chunks: rx,
            pending: Default::default(),
            lines: Default::default(),
        }
    }

    fn next(&self) -> Event {
        loop {
            if let Some(line) = self.lines.borrow_mut().pop_front() {
                return Event::Line(line);
            }
            match self.chunks.recv_timeout(Duration::from_millis(400)) {
                Ok(bytes) => {
                    let mut pending = self.pending.borrow_mut();
                    pending.extend_from_slice(&bytes);
                    while let Some(at) = pending.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = pending.drain(..=at).collect();
                        self.lines
                            .borrow_mut()
                            .push_back(String::from_utf8_lossy(&line).trim_end().to_string());
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let pending = self.pending.borrow();
                    if !pending.is_empty() {
                        return Event::Waiting(String::from_utf8_lossy(&pending).into_owned());
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let rest = std::mem::take(&mut *self.pending.borrow_mut());
                    if !rest.is_empty() {
                        return Event::Line(String::from_utf8_lossy(&rest).trim_end().to_string());
                    }
                    return Event::End;
                }
            }
        }
    }
}
