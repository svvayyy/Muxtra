//! Things on the computer running `muxtra`: QEMU, the download cache, and
//! the official Debian image the hidden builder boots from.

use crate::style::{self, Role};
use crate::{Failure, prompt};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

/// The builder runs as the host's own CPU type, so it is fast everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arch {
    Arm64,
    Amd64,
}

impl Arch {
    pub fn host() -> Arch {
        if cfg!(target_arch = "aarch64") {
            Arch::Arm64
        } else {
            Arch::Amd64
        }
    }

    /// Debian's name for it.
    pub fn debian(self) -> &'static str {
        match self {
            Arch::Arm64 => "arm64",
            Arch::Amd64 => "amd64",
        }
    }

    fn qemu_system(self) -> &'static str {
        match self {
            Arch::Arm64 => "qemu-system-aarch64",
            Arch::Amd64 => "qemu-system-x86_64",
        }
    }
}

/// A usable QEMU install.
#[derive(Debug, Clone)]
pub struct Qemu {
    /// qemu-system-aarch64 or qemu-system-x86_64, matching the host.
    pub system: PathBuf,
    /// qemu-system-x86_64, for booting the finished Intel Mac image.
    pub x86: PathBuf,
    pub img: PathBuf,
    /// Where QEMU keeps its firmware files.
    pub share: PathBuf,
}

const SEARCH_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

fn find_program(name: &str) -> Option<PathBuf> {
    let from_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    from_path
        .into_iter()
        .chain(SEARCH_DIRS.iter().map(PathBuf::from))
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

fn find_qemu(arch: Arch) -> Option<Qemu> {
    let system = find_program(arch.qemu_system())?;
    let x86 = find_program(Arch::Amd64.qemu_system())?;
    let img = find_program("qemu-img")?;
    let bin = system.parent()?;
    let share = [bin.join("../share/qemu"), PathBuf::from("/usr/share/qemu")]
        .into_iter()
        .find(|p| p.is_dir())?;
    Some(Qemu {
        system,
        x86,
        img,
        share,
    })
}

/// Finds QEMU, or offers to install it with Homebrew.
pub fn ensure_qemu(arch: Arch, yes: bool) -> Result<Qemu, Failure> {
    if let Some(qemu) = find_qemu(arch) {
        return Ok(qemu);
    }
    let Some(brew) = find_program("brew") else {
        return Err(Failure(
            "Muxtra needs QEMU, the free virtual machine program. Install Homebrew from https://brew.sh, then run `brew install qemu`.".to_string(),
        ));
    };
    let o = style::out();
    if !yes {
        if !prompt::someone_is_here() {
            return Err(Failure(
                "Muxtra needs QEMU, the free virtual machine program. Run again with --yes to let Muxtra install it with Homebrew, or run `brew install qemu`.".to_string(),
            ));
        }
        let answer = prompt::ask(
            "Muxtra needs QEMU, the free virtual machine program. Install it now with Homebrew? (Y/n)",
            Some("Y"),
        )?;
        if !answer.eq_ignore_ascii_case("y") && !answer.eq_ignore_ascii_case("yes") {
            return Err(Failure(
                "Not installing QEMU. Run `brew install qemu` whenever you are ready.".to_string(),
            ));
        }
    }
    println!(
        "{}",
        o.rich(Role::Dim, "Installing QEMU with `brew install qemu`…")
    );
    let status = Command::new(brew).args(["install", "qemu"]).status()?;
    if !status.success() {
        return Err(Failure(
            "Homebrew could not install QEMU. Try `brew install qemu` yourself to see why."
                .to_string(),
        ));
    }
    find_qemu(arch)
        .ok_or_else(|| Failure("QEMU installed, but Muxtra still cannot find it.".to_string()))
}

/// Where Muxtra keeps downloads it can reuse.
pub fn cache_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    if cfg!(target_os = "macos") {
        home.join("Library/Caches/Muxtra")
    } else if let Some(xdg) = std::env::var_os("XDG_CACHE_HOME") {
        PathBuf::from(xdg).join("muxtra")
    } else {
        home.join(".cache/muxtra")
    }
}

/// Debian's version number for a release name.
fn debian_number(release: &str) -> Option<&'static str> {
    match release {
        "trixie" => Some("13"),
        _ => None,
    }
}

/// How long a cached builder image is used before checking for a newer one.
const REFRESH_AFTER: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// The official Debian cloud image the builder boots, downloaded once and
/// checked against Debian's published SHA-512 sums.
pub fn builder_image(release: &str, arch: Arch) -> Result<PathBuf, Failure> {
    let number = debian_number(release).ok_or_else(|| {
        Failure(format!(
            "Muxtra does not know how to build Debian \"{release}\" yet."
        ))
    })?;
    let name = format!("debian-{number}-genericcloud-{}.qcow2", arch.debian());
    let base = format!("https://cloud.debian.org/images/cloud/{release}/latest");
    let dir = cache_dir();
    fs::create_dir_all(&dir)?;
    let image = dir.join(&name);
    let sum_file = dir.join(format!("{name}.sha512"));

    // A cached image that still matches its saved sum is good to use, and
    // works offline. Refresh it once in a while.
    let fresh = fs::metadata(&image)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < REFRESH_AFTER);
    if fresh
        && let Ok(saved) = fs::read_to_string(&sum_file)
        && sha512_file(&image)? == saved.trim()
    {
        return Ok(image);
    }

    let o = style::out();
    let sums = curl_text(&format!("{base}/SHA512SUMS"))?;
    let expected = sums
        .lines()
        .find_map(|l| {
            let (sum, file) = l.split_once(char::is_whitespace)?;
            (file.trim().trim_start_matches('*') == name).then(|| sum.to_string())
        })
        .ok_or_else(|| Failure(format!("Debian's checksum list has no entry for {name}.")))?;
    if image.exists() && sha512_file(&image)? == expected {
        fs::write(&sum_file, &expected)?;
        touch(&image);
        return Ok(image);
    }

    println!(
        "{}",
        o.paint(
            Role::Dim,
            &format!("Downloading the Debian {number} builder image ({name}). This happens once.")
        )
    );
    let partial = dir.join(format!("{name}.partial"));
    let mut curl = Command::new("curl");
    curl.args(["-fL", "--retry", "3", "-o"])
        .arg(&partial)
        .arg(format!("{base}/{name}"));
    if prompt::someone_is_here() {
        curl.arg("--progress-bar");
    } else {
        curl.arg("-sS");
    }
    if !curl.status()?.success() {
        return Err(Failure(format!(
            "Could not download {name}. Check your internet connection and try again."
        )));
    }
    let got = sha512_file(&partial)?;
    if got != expected {
        let _ = fs::remove_file(&partial);
        return Err(Failure(format!(
            "The downloaded {name} does not match Debian's published checksum, so Muxtra will not use it. Try again later."
        )));
    }
    fs::rename(&partial, &image)?;
    fs::write(&sum_file, &expected)?;
    Ok(image)
}

fn touch(path: &Path) {
    if let Ok(file) = fs::File::options().append(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

fn curl_text(url: &str) -> Result<String, Failure> {
    let out = Command::new("curl")
        .args(["-fsSL", "--retry", "3", url])
        .stderr(Stdio::null())
        .output()?;
    if !out.status.success() {
        return Err(Failure(format!(
            "Could not reach {url}. Check your internet connection and try again."
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// SHA-512 of a file, as lowercase hex.
pub fn sha512_file(path: &Path) -> Result<String, Failure> {
    use sha2::{Digest, Sha512};
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha512::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Makes the cloud-init seed disc (an ISO labelled "cidata").
pub fn make_seed_iso(dir: &Path, iso: &Path) -> Result<(), Failure> {
    let _ = fs::remove_file(iso);
    let status = if cfg!(target_os = "macos") {
        Command::new("hdiutil")
            .args([
                "makehybrid",
                "-quiet",
                "-iso",
                "-joliet",
                "-default-volume-name",
                "cidata",
                "-o",
            ])
            .arg(iso)
            .arg(dir)
            .status()?
    } else {
        let tool = ["xorriso", "genisoimage", "mkisofs"]
            .into_iter()
            .find(|t| find_program(t).is_some())
            .ok_or_else(|| Failure("Building on Linux needs xorriso or genisoimage. Install one with your package manager.".to_string()))?;
        let mut cmd = Command::new(tool);
        if tool == "xorriso" {
            cmd.args(["-as", "mkisofs"]);
        }
        cmd.args(["-quiet", "-volid", "cidata", "-joliet", "-rock", "-o"])
            .arg(iso)
            .arg(dir)
            .status()?
    };
    if status.success() {
        Ok(())
    } else {
        Err(Failure(
            "Could not make the builder's setup disc.".to_string(),
        ))
    }
}

/// UEFI firmware for an Intel PC: (code, a template for its settings).
pub fn x86_firmware(qemu: &Qemu) -> Result<(PathBuf, PathBuf), Failure> {
    let pairs: [(PathBuf, PathBuf); 4] = [
        (
            qemu.share.join("edk2-x86_64-code.fd"),
            qemu.share.join("edk2-i386-vars.fd"),
        ),
        (
            "/usr/share/OVMF/OVMF_CODE_4M.fd".into(),
            "/usr/share/OVMF/OVMF_VARS_4M.fd".into(),
        ),
        (
            "/usr/share/OVMF/OVMF_CODE.fd".into(),
            "/usr/share/OVMF/OVMF_VARS.fd".into(),
        ),
        (
            "/usr/share/edk2/x64/OVMF_CODE.4m.fd".into(),
            "/usr/share/edk2/x64/OVMF_VARS.4m.fd".into(),
        ),
    ];
    pairs
        .into_iter()
        .find(|(code, vars)| code.is_file() && vars.is_file())
        .ok_or_else(|| {
            Failure(
                "Could not find UEFI firmware for the test VM. On Linux, install the ovmf package."
                    .to_string(),
            )
        })
}

/// How to run an Intel (x86-64) VM here: hardware speed on Intel hosts,
/// emulation on Apple Silicon.
pub fn x86_accelerator() -> &'static str {
    if Arch::host() == Arch::Amd64 {
        accelerator()
    } else {
        "tcg"
    }
}

/// The fastest way to run a VM of the host's own CPU type.
pub fn accelerator() -> &'static str {
    if cfg!(target_os = "macos") {
        "hvf"
    } else if fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/kvm")
        .is_ok()
    {
        "kvm"
    } else {
        "tcg"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha512_of_a_known_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("abc");
        fs::write(&path, "abc").unwrap();
        assert_eq!(
            sha512_file(&path).unwrap(),
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
        );
    }

    #[test]
    fn debian_numbers() {
        assert_eq!(debian_number("trixie"), Some("13"));
        assert_eq!(debian_number("bookworm"), None);
    }
}
