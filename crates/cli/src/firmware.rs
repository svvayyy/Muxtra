//! `muxtra firmware`: copy Apple's Wi-Fi firmware from a Mac's own macOS.
//!
//! T2 Macs need it for Wi-Fi under Linux, and only macOS has it. It is
//! Apple's, so Muxtra never ships or shares it: this copies it into a
//! `firmware/` folder next to muxtra.toml, which git ignores, and
//! `muxtra build` puts it in the image.

use crate::style::{self, Role, say};
use crate::{Failure, files};
use clap::Args;
use muxtra_build::apple_firmware;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Where macOS keeps it.
const MACOS_WIFI: &str = "/usr/share/firmware/wifi";
/// Where Muxtra keeps its copy, next to muxtra.toml.
const FOLDER: &str = "firmware";

#[derive(Args)]
pub struct FirmwareArgs {
    /// The Mac to copy it from while it runs macOS, as you would `ssh` to it
    /// (like `my-mac.local` or `me@192.168.1.20`). Leave out on that Mac itself.
    #[arg(long)]
    from: Option<String>,
    /// Path to muxtra.toml, or the folder that holds it
    #[arg(long, default_value = ".")]
    manifest: PathBuf,
}

pub fn run(args: FirmwareArgs) -> Result<(), Failure> {
    let (path, manifest) = files::load_manifest(&args.manifest)?;
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .to_path_buf();
    let target = wifi_dir(&dir);
    let incoming = dir.join(FOLDER).join(".incoming");
    let _ = fs::remove_dir_all(&incoming);
    fs::create_dir_all(&incoming)?;

    let o = style::out();
    let source = match &args.from {
        Some(host) => {
            say(&style::progress().paint(Role::Dim, &format!("Copying from {host}...")));
            copy_over_ssh(host, &incoming)?;
            host.clone()
        }
        None => {
            if !Path::new(MACOS_WIFI).is_dir() {
                let _ = fs::remove_dir_all(&incoming);
                return Err(Failure(format!(
                    "This Mac has no {MACOS_WIFI}. Run this on the Mac itself while it runs macOS, or copy from it with --from."
                )));
            }
            copy_local(Path::new(MACOS_WIFI), &incoming)?;
            "this Mac".to_string()
        }
    };

    let found = read(&incoming)?;
    let linux = apple_firmware::linux_files(&found).map_err(Failure)?;
    if linux.is_empty() {
        let _ = fs::remove_dir_all(&incoming);
        return Err(Failure(format!(
            "{source} has no Wi-Fi firmware for a T2 Mac. Copy it from a Mac with the T2 chip, like a 2018 to 2020 MacBook Pro."
        )));
    }
    let _ = fs::remove_dir_all(&target);
    fs::create_dir_all(target.parent().expect("wifi_dir has a parent"))?;
    fs::rename(&incoming, &target)?;
    files::ensure_gitignored(&dir, &format!("{FOLDER}/"))?;

    println!(
        "{} Copied Apple's Wi-Fi firmware from {} ({} files for Linux).",
        o.paint(Role::Ok, "✓"),
        o.paint(Role::Value, &source),
        linux.len()
    );
    println!(
        "{}",
        o.paint(
            Role::Dim,
            &format!(
                "It is kept in {FOLDER}/, which git ignores, and only goes into images you build."
            )
        )
    );
    if let Some(model) = args.from.as_deref().and_then(model_of)
        && model != manifest.system.mac
    {
        println!(
            "{} {source} is a {model}, but muxtra.toml is for a {}. That works when both have the same Wi-Fi chip.",
            o.paint(Role::Warn, "!"),
            manifest.system.mac
        );
    }
    println!(
        "{}",
        o.rich(Role::Dim, "It takes effect on the next `muxtra build`.")
    );
    Ok(())
}

/// Where the copy lives for a project folder.
fn wifi_dir(dir: &Path) -> PathBuf {
    dir.join(FOLDER).join("apple").join("wifi")
}

/// The firmware, renamed for Linux and packed for the builder, when it has
/// been copied. None when there is no copy yet.
pub fn packed(dir: &Path) -> Result<Option<Vec<u8>>, Failure> {
    let wifi = wifi_dir(dir);
    if !wifi.is_dir() {
        return Ok(None);
    }
    let linux = apple_firmware::linux_files(&read(&wifi)?).map_err(Failure)?;
    if linux.is_empty() {
        return Ok(None);
    }
    Ok(Some(apple_firmware::archive(&linux)))
}

/// Every file one folder deep, as (folder/name, contents).
fn read(wifi: &Path) -> Result<Vec<(String, Vec<u8>)>, Failure> {
    let mut out = Vec::new();
    for folder in fs::read_dir(wifi)? {
        let folder = folder?.path();
        if !folder.is_dir() {
            continue;
        }
        let Some(folder_name) = folder
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        for file in fs::read_dir(&folder)? {
            let file = file?.path();
            if file.is_file()
                && let Some(name) = file.file_name().and_then(|n| n.to_str())
            {
                out.push((format!("{folder_name}/{name}"), fs::read(&file)?));
            }
        }
    }
    Ok(out)
}

/// Copies the T2 chip folders from another Mac's macOS over SSH.
fn copy_over_ssh(host: &str, into: &Path) -> Result<(), Failure> {
    let folders = apple_firmware::chip_folders().join(" ");
    let remote = format!(
        "cd {MACOS_WIFI} 2>/dev/null || {{ echo no-firmware-folder >&2; exit 3; }}; tar -cf - $(ls -d {folders} 2>/dev/null)"
    );
    let mut ssh = Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            host,
            &remote,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| Failure("Could not run ssh on this Mac.".to_string()))?;
    let unpack = Command::new("tar")
        .arg("-xf")
        .arg("-")
        .arg("-C")
        .arg(into)
        .stdin(ssh.stdout.take().expect("stdout is piped"))
        .stderr(Stdio::null())
        .status()?;
    let out = ssh.wait_with_output()?;
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("no-firmware-folder") {
        return Err(Failure(format!(
            "{host} has no {MACOS_WIFI}. Copy it from the Mac while it runs macOS."
        )));
    }
    if !out.status.success() || !unpack.success() {
        return Err(Failure(format!(
            "Could not copy the firmware from {host}. Make sure `ssh {host}` works from this Mac."
        )));
    }
    Ok(())
}

fn copy_local(from: &Path, into: &Path) -> Result<(), Failure> {
    for folder in apple_firmware::chip_folders() {
        let src = from.join(folder);
        if !src.is_dir() {
            continue;
        }
        let dst = into.join(folder);
        fs::create_dir_all(&dst)?;
        for file in fs::read_dir(&src)? {
            let file = file?.path();
            if file.is_file()
                && let Some(name) = file.file_name()
            {
                fs::copy(&file, dst.join(name))?;
            }
        }
    }
    Ok(())
}

/// The Mac model of another Mac, if `ssh` and `sysctl` answer.
fn model_of(host: &str) -> Option<String> {
    let out = Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            host,
            "sysctl -n hw.model",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let model = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !model.is_empty()).then_some(model)
}
