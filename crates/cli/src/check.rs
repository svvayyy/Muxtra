//! `muxtra check`: boot the image in a virtual Intel Mac and report, in
//! plain English, what works. Builds first if the image is missing or
//! out of date. The image itself is never changed.

use crate::build::{self, clock};
use crate::host::{self, Arch};
use crate::style::{self, Role, say};
use crate::{Failure, ManifestArgs, prompt};
use clap::Args;
use muxtra_build::check::{self as probe, Check, Observed, Status};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Args)]
pub struct CheckArgs {
    #[command(flatten)]
    manifest: ManifestArgs,
    /// Say yes to installing what the check needs (QEMU)
    #[arg(long, short = 'y')]
    yes: bool,
    /// Print the results as JSON, for agents and scripts
    #[arg(long)]
    json: bool,
    /// Leave the VM running after the report, so you can sign in and look around
    #[arg(long)]
    stay: bool,
}

/// Longest wait for the login prompt (emulated Intel boots are slower).
const BOOT_TIMEOUT: Duration = Duration::from_secs(300);
/// Longest wait for SSH after the login prompt.
const SSH_TIMEOUT: Duration = Duration::from_secs(120);

/// Stops the VM when the check ends, unless told to leave it running.
struct Vm {
    child: Child,
    keep: bool,
}

impl Drop for Vm {
    fn drop(&mut self) {
        if !self.keep {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

pub fn run(args: CheckArgs) -> Result<(), Failure> {
    if args.json {
        style::send_progress_to_stderr();
    }
    let p = build::prepare(&args.manifest.manifest)?;
    let o = style::progress();
    if let Some(why) = p.needs_build() {
        say(&o.paint(Role::Dim, why));
        build::build_image(&p, args.yes)?;
        say("");
    }

    let qemu = host::ensure_qemu(Arch::host(), args.yes)?;
    let (code, vars_template) = host::x86_firmware(&qemu)?;
    let work = p.build_dir().join(".check");
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work)?;
    let vars = work.join("vars.fd");
    fs::copy(&vars_template, &vars)?;
    let console = work.join("console.log");
    let port = free_port()?;
    let accel = host::x86_accelerator();

    let name = &p.manifest.system.name;
    let emulated = if accel == "tcg" {
        " Intel is emulated on this Mac, so this takes about a minute."
    } else {
        ""
    };
    say(&format!(
        "{} {} {}",
        o.paint(Role::Accent, "Checking"),
        o.paint(Role::Value, name),
        o.paint(Role::Dim, &format!("in a virtual Intel Mac.{emulated}"))
    ));

    let cpus = std::thread::available_parallelism().map_or(2, |n| n.get().min(4));
    let child = Command::new(&qemu.x86)
        .args(["-machine", "q35", "-accel", accel, "-cpu"])
        .arg(if accel == "tcg" { "max" } else { "host" })
        .args(["-smp", &cpus.to_string(), "-m", "2048"])
        .arg("-drive")
        .arg(format!(
            "if=pflash,format=raw,readonly=on,file={}",
            code.display()
        ))
        .arg("-drive")
        .arg(format!("if=pflash,format=raw,file={}", vars.display()))
        // snapshot=on: nothing the check does is written back to the image.
        .arg("-drive")
        .arg(format!(
            "if=virtio,file={},format=raw,snapshot=on",
            p.image().display()
        ))
        .arg("-nic")
        .arg(format!(
            "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:{port}-:22"
        ))
        .args(["-display", "none", "-monitor", "none", "-serial"])
        .arg(format!("file:{}", console.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(fs::File::create(work.join("qemu.log"))?)
        .spawn()
        .map_err(|e| Failure(format!("Could not start the test VM: {e}")))?;
    let mut vm = Vm { child, keep: false };

    let started = Instant::now();
    let mut seen = Observed::default();
    while started.elapsed() < BOOT_TIMEOUT {
        if fs::read(&console).is_ok_and(|b| String::from_utf8_lossy(&b).contains("login:")) {
            seen.boot_seconds = Some(started.elapsed().as_secs());
            break;
        }
        if vm.child.try_wait()?.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }

    let user = &p.manifest.user.name;
    let mut facts = Default::default();
    if seen.boot_seconds.is_some()
        && p.manifest
            .modules
            .remote
            .contains(&muxtra_manifest::Remote::Ssh)
    {
        let ssh_ready = Instant::now();
        while ssh_ready.elapsed() < SSH_TIMEOUT {
            if ssh(port, user, &p.identities, "true", None).is_some() {
                seen.ssh = true;
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        if seen.ssh {
            seen.sftp = sftp_works(port, user, &p.identities);
            let script = probe::probe_script(&p.manifest);
            let output =
                ssh(port, user, &p.identities, "bash -s", Some(&script)).unwrap_or_default();
            facts = probe::parse_facts(&output);
        }
    }

    let checks = probe::report(&p.manifest, &p.plan, &seen, &facts);
    let (passed, failed, real_mac) = probe::tally(&checks);
    let ssh_command = format!(
        "ssh -p {port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null {user}@127.0.0.1"
    );

    if args.json {
        let rows: Vec<_> = checks
            .iter()
            .map(|c| serde_json::json!({ "name": c.name, "status": c.status.as_str(), "detail": c.detail }))
            .collect();
        let mut doc = serde_json::json!({
            "ok": failed == 0,
            "name": name,
            "mac": p.manifest.system.mac,
            "image": p.image(),
            "passed": passed,
            "failed": failed,
            "needs_real_mac": real_mac,
            "seconds": started.elapsed().as_secs(),
            "checks": rows,
        });
        if args.stay {
            doc["ssh"] = serde_json::json!(ssh_command);
            doc["pid"] = serde_json::json!(vm.child.id());
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&doc).expect("JSON always serializes")
        );
    } else {
        print_report(&checks, passed, failed, real_mac, started.elapsed());
    }

    if !seen.ssh || seen.boot_seconds.is_none() {
        let _ = fs::copy(&console, p.build_dir().join("check.log"));
    }

    if args.stay {
        vm.keep = true;
        let o = style::progress();
        say(&format!(
            "\n{} {}",
            o.paint(Role::Accent, "Still running."),
            o.rich(Role::Dim, &format!("Sign in with `{ssh_command}`"))
        ));
        if prompt::someone_is_here() && !args.json {
            let _ = prompt::ask("Press Enter to stop it", Some(""));
            vm.keep = false;
        } else {
            say(&o.rich(
                Role::Dim,
                &format!("Stop it with `kill {}`.", vm.child.id()),
            ));
        }
    }
    drop(vm);

    if failed > 0 {
        return Err(Failure(String::new()));
    }
    Ok(())
}

fn print_report(checks: &[Check], passed: usize, failed: usize, real_mac: usize, took: Duration) {
    let o = style::out();
    println!();
    for c in checks {
        let (mark, role) = match c.status {
            Status::Pass => ("✓", Role::Ok),
            Status::Fail => ("✗", Role::Err),
            Status::RealMac => ("!", Role::Warn),
        };
        let detail_role = match c.status {
            Status::Pass => Role::Dim,
            Status::Fail => Role::Err,
            Status::RealMac => Role::Warn,
        };
        println!(
            "{} {} {}",
            o.paint(role, mark),
            format_args!("{:<12}", c.name),
            o.paint(detail_role, &c.detail)
        );
    }
    let mut summary = vec![format!("{passed} passed")];
    if failed > 0 {
        summary.push(format!("{failed} failed"));
    }
    if real_mac > 0 {
        summary.push(format!("{real_mac} need a real Mac"));
    }
    println!(
        "\n{}. {}",
        summary.join(", "),
        o.paint(Role::Dim, &format!("Took {}.", clock(took)))
    );
    if failed == 0 {
        println!(
            "\n{} {} {}",
            o.paint(Role::Accent, "Next"),
            o.paint(Role::Dim, "→"),
            o.paint(Role::Cmd, "muxtra poof")
        );
    } else {
        println!(
            "\n{}",
            o.rich(
                Role::Dim,
                "To look around inside, run `muxtra check --stay` and sign in."
            )
        );
    }
}

/// A TCP port nothing else is using right now.
fn free_port() -> Result<u16, Failure> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn ssh_options(identities: &[PathBuf]) -> Vec<String> {
    let mut args: Vec<String> = [
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    for id in identities {
        args.push("-i".to_string());
        args.push(id.display().to_string());
    }
    args
}

/// Runs a command in the VM over SSH. Returns its output when it succeeds.
fn ssh(
    port: u16,
    user: &str,
    identities: &[PathBuf],
    command: &str,
    stdin: Option<&str>,
) -> Option<String> {
    let mut child = Command::new("ssh")
        .args(["-p", &port.to_string()])
        .args(ssh_options(identities))
        .arg(format!("{user}@127.0.0.1"))
        .arg(command)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    if let Some(input) = stdin {
        child.stdin.take()?.write_all(input.as_bytes()).ok()?;
    }
    let out = child.wait_with_output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Opens an SFTP session and lists the home folder.
fn sftp_works(port: u16, user: &str, identities: &[PathBuf]) -> bool {
    let Ok(mut child) = Command::new("sftp")
        .args(["-b", "-", "-P", &port.to_string()])
        .args(ssh_options(identities))
        .arg(format!("{user}@127.0.0.1"))
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
