//! `muxtra poof` (quiet alias `flash`): put Muxtra on a drive.
//!
//! Only external drives are offered: USB sticks and Macs in Target Disk
//! Mode. The drive Muxtra runs from is never touched. Writing needs admin
//! rights, so the actual write runs as a small `sudo` step
//! (`muxtra poof-write`) after everything is chosen and confirmed.

use crate::build;
use crate::style::{self, Role, say};
use crate::{Failure, ManifestArgs, prompt};
use clap::Args;
use muxtra_build::disk::{self, SECTOR};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Args)]
pub struct PoofArgs {
    #[command(flatten)]
    manifest: ManifestArgs,
    /// The drive to erase, like disk4 (see the list Muxtra shows)
    #[arg(long)]
    disk: Option<String>,
    /// Skip the confirmation. Agents must also name the drive with --disk.
    #[arg(long, short = 'y')]
    yes: bool,
    /// Do not add the Mac to ~/.ssh/config
    #[arg(long)]
    no_ssh_config: bool,
}

#[derive(Args)]
pub struct PoofWriteArgs {
    /// The built image
    #[arg(long)]
    image: PathBuf,
    /// The drive (or, for testing, a file) to write
    #[arg(long)]
    device: PathBuf,
    /// The drive's size in bytes
    #[arg(long)]
    size: u64,
}

/// Smallest drive worth trying: EFI, one system slot and a little home.
const MIN_DRIVE_BYTES: u64 = 6_500_000_000;

/// An external drive that poof may erase.
#[derive(Debug, Clone)]
pub struct Drive {
    /// Like "disk4".
    pub id: String,
    /// Where to write: /dev/rdisk4 on macOS, /dev/sdb on Linux.
    pub device: PathBuf,
    pub name: String,
    pub bytes: u64,
    pub bus: String,
}

pub fn run(args: PoofArgs) -> Result<(), Failure> {
    let p = build::prepare(&args.manifest.manifest)?;
    let o = style::out();

    // Pick and check the drive first, so nobody waits for a build only to
    // hear the drive is wrong.
    let drives = external_drives()?;
    let interactive = prompt::someone_is_here();
    let drive = match &args.disk {
        Some(wanted) => {
            let wanted = wanted.trim_start_matches("/dev/");
            let wanted = wanted
                .strip_prefix("rdisk")
                .map_or(wanted.to_string(), |n| format!("disk{n}"));
            drives
                .iter()
                .find(|d| d.id == wanted)
                .cloned()
                .ok_or_else(|| {
                    Failure(format!(
                        "\"{wanted}\" is not an external drive Muxtra can use. Muxtra only writes to USB drives and Macs in Target Disk Mode, never to the disk it runs from.{}",
                        list_hint(&drives)
                    ))
                })?
        }
        None if interactive => pick(&drives)?,
        None => {
            return Err(Failure(format!(
                "Name the drive to erase with --disk, and confirm with --yes. Muxtra never picks a drive for you.{}",
                list_hint(&drives)
            )));
        }
    };

    if drive.bytes < MIN_DRIVE_BYTES {
        return Err(Failure(format!(
            "{} is too small ({}). Muxtra needs a drive of at least {}.",
            drive.name,
            gb(drive.bytes),
            gb(MIN_DRIVE_BYTES)
        )));
    }

    if !args.yes {
        if !interactive {
            return Err(Failure(format!(
                "This erases everything on {} ({}). Add --yes to confirm.",
                drive.name,
                gb(drive.bytes)
            )));
        }
        println!(
            "\n{} {} {}",
            o.paint(Role::Warn, "This erases everything on"),
            o.paint(
                Role::Value,
                &format!("{} ({}, {})", drive.name, gb(drive.bytes), drive.id)
            ),
            o.paint(Role::Warn, "and puts Muxtra on it.")
        );
        let answer = prompt::ask("Type erase to continue", None)?;
        if answer != "erase" {
            return Err(Failure("Nothing was erased.".to_string()));
        }
    }

    if let Some(why) = p.needs_build() {
        say(&o.paint(Role::Dim, why));
        build::build_image(&p, args.yes)?;
        say("");
    }
    let image = p.image();
    // The exact layout is checked before anything is erased.
    let parts = disk::read_gpt(&read_head(&image)?)?;
    let layout = disk::fit(&parts, drive.bytes)?;

    say(&format!(
        "{} {} {}",
        o.paint(Role::Accent, "Writing"),
        o.paint(Role::Value, &p.manifest.system.name),
        o.paint(
            Role::Dim,
            &format!(
                "to {}. Muxtra needs admin rights to write a drive.",
                drive.name
            )
        )
    ));
    unmount(&drive)?;
    let exe = std::env::current_exe()?;
    let mut write = Command::new("sudo");
    if !interactive {
        write.arg("-n");
    }
    let status = write
        .arg("--")
        .arg(&exe)
        .args(["poof-write", "--image"])
        .arg(&image)
        .arg("--device")
        .arg(&drive.device)
        .arg("--size")
        .arg(drive.bytes.to_string())
        .status()?;
    if !status.success() {
        return Err(Failure(if interactive {
            "The drive was not written.".to_string()
        } else {
            format!(
                "Writing a drive needs admin rights, which an agent cannot give. Run `muxtra poof --disk {} --yes` yourself in a terminal. It will ask for your password.",
                drive.id
            )
        }));
    }
    eject(&drive);

    let slot_b = if layout.has_slot_b {
        "with both system slots"
    } else {
        "with one system slot (the drive is too small for a second one)"
    };
    println!(
        "\n{} Muxtra is on {} ({}), {}.",
        o.paint(Role::Ok, "✓"),
        o.paint(Role::Value, &drive.name),
        gb(drive.bytes),
        slot_b
    );
    let name = &p.manifest.system.name;
    if !args.no_ssh_config
        && p.manifest
            .modules
            .remote
            .contains(&muxtra_manifest::Remote::Ssh)
    {
        add_ssh_host(name, &p.manifest.user.name, &p.identities)?;
        println!(
            "{} {}",
            o.paint(Role::Ok, "✓"),
            o.rich(
                Role::Dim,
                &format!("Added {name} to ~/.ssh/config, so `ssh {name}` works.")
            )
        );
    }
    let mac = muxtra_build::hardware::lookup(&p.manifest.system.mac)
        .map_or(p.manifest.system.mac.clone(), |m| m.name.to_string());
    println!("\n{}", o.paint(Role::Accent, "Next"));
    println!("  1. Plug the drive into the {mac}.");
    println!("  2. Turn it on while holding Option, then pick \"EFI Boot\".");
    println!(
        "  3. {}",
        o.rich(Role::Plain, &format!("From this Mac, run `ssh {name}`."))
    );
    Ok(())
}

fn list_hint(drives: &[Drive]) -> String {
    if drives.is_empty() {
        return " No external drives are plugged in right now.".to_string();
    }
    let list: Vec<String> = drives
        .iter()
        .map(|d| format!("{} ({}, {})", d.id, d.name, gb(d.bytes)))
        .collect();
    format!(" External drives: {}.", list.join(", "))
}

fn pick(drives: &[Drive]) -> Result<Drive, Failure> {
    if drives.is_empty() {
        return Err(Failure(
            "No external drives are plugged in. Plug in a USB drive, or connect a Mac in Target Disk Mode (hold T while it starts).".to_string(),
        ));
    }
    let o = style::out();
    println!("{}", o.paint(Role::Accent, "External drives"));
    for (i, d) in drives.iter().enumerate() {
        println!(
            "  {}  {} {}",
            o.paint(Role::Value, &(i + 1).to_string()),
            d.name,
            o.paint(Role::Dim, &format!("{}, {}, {}", gb(d.bytes), d.bus, d.id))
        );
    }
    loop {
        let answer = prompt::ask("Which drive?", None)?;
        if let Some(d) = answer
            .parse::<usize>()
            .ok()
            .and_then(|n| drives.get(n.wrapping_sub(1)))
        {
            return Ok(d.clone());
        }
        println!("Type the number next to the drive.");
    }
}

fn gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1e9)
}

fn read_head(image: &Path) -> Result<Vec<u8>, Failure> {
    let mut head = vec![0u8; 34 * SECTOR as usize];
    fs::File::open(image)?.read_exact(&mut head)?;
    Ok(head)
}

// ---------------------------------------------------------------------------
// Finding drives

#[cfg(target_os = "macos")]
pub fn external_drives() -> Result<Vec<Drive>, Failure> {
    use std::process::Stdio;
    /// Runs `diskutil <verb> -plist <rest>` and reads the plist as JSON.
    fn diskutil(verb: &str, rest: &[&str]) -> Option<serde_json::Value> {
        let out = Command::new("diskutil")
            .arg(verb)
            .arg("-plist")
            .args(rest)
            .output()
            .ok()?;
        let mut conv = Command::new("plutil")
            .args(["-convert", "json", "-o", "-", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .ok()?;
        conv.stdin.take()?.write_all(&out.stdout).ok()?;
        serde_json::from_slice(&conv.wait_with_output().ok()?.stdout).ok()
    }
    let list = diskutil("list", &["external", "physical"]).unwrap_or_default();
    let boot_disk = diskutil("info", &["/"])
        .and_then(|v| v["ParentWholeDisk"].as_str().map(str::to_string))
        .unwrap_or_default();
    let mut drives = Vec::new();
    for id in list["WholeDisks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
    {
        if id == boot_disk {
            continue;
        }
        let Some(info) = diskutil("info", &[id]) else {
            continue;
        };
        if info["Internal"].as_bool() == Some(true)
            || info["VirtualOrPhysical"].as_str() == Some("Virtual")
        {
            continue;
        }
        let bytes = info["TotalSize"]
            .as_u64()
            .or_else(|| info["Size"].as_u64())
            .unwrap_or(0);
        let name = info["MediaName"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string();
        drives.push(Drive {
            id: id.to_string(),
            device: PathBuf::from(format!("/dev/r{id}")),
            name: if name.is_empty() {
                "Unnamed drive".to_string()
            } else {
                name
            },
            bytes,
            bus: info["BusProtocol"]
                .as_str()
                .unwrap_or("external")
                .to_string(),
        });
    }
    Ok(drives)
}

#[cfg(not(target_os = "macos"))]
pub fn external_drives() -> Result<Vec<Drive>, Failure> {
    let out = Command::new("lsblk")
        .args(["-J", "-b", "-d", "-o", "NAME,SIZE,MODEL,TRAN,RM,TYPE"])
        .output()?;
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    let root = Command::new("findmnt")
        .args(["-no", "SOURCE", "/"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let mut drives = Vec::new();
    for d in json["blockdevices"].as_array().into_iter().flatten() {
        let name = d["name"].as_str().unwrap_or_default();
        let usb = d["tran"].as_str() == Some("usb") || d["rm"].as_bool() == Some(true);
        if d["type"].as_str() != Some("disk") || !usb || root.contains(name) {
            continue;
        }
        drives.push(Drive {
            id: name.to_string(),
            device: PathBuf::from(format!("/dev/{name}")),
            name: d["model"]
                .as_str()
                .unwrap_or("USB drive")
                .trim()
                .to_string(),
            bytes: d["size"].as_u64().unwrap_or(0),
            bus: d["tran"].as_str().unwrap_or("usb").to_string(),
        });
    }
    Ok(drives)
}

fn unmount(drive: &Drive) -> Result<(), Failure> {
    let ok = if cfg!(target_os = "macos") {
        Command::new("diskutil")
            .args(["unmountDisk", "force", &format!("/dev/{}", drive.id)])
            .stdout(std::process::Stdio::null())
            .status()?
            .success()
    } else {
        // Linux: unmount anything mounted from the drive, ignoring errors.
        let _ = Command::new("sh")
            .args([
                "-c",
                &format!(
                    "for p in /dev/{}?*; do umount \"$p\" 2>/dev/null; done",
                    drive.id
                ),
            ])
            .status();
        true
    };
    if ok {
        Ok(())
    } else {
        Err(Failure(format!(
            "Could not unmount {}. Close anything using it and try again.",
            drive.name
        )))
    }
}

fn eject(drive: &Drive) {
    if cfg!(target_os = "macos") {
        let _ = Command::new("diskutil")
            .args(["eject", &format!("/dev/{}", drive.id)])
            .stdout(std::process::Stdio::null())
            .status();
    }
}

// ---------------------------------------------------------------------------
// Writing (runs as root through sudo)

/// The privileged step: lays out the drive and copies the system onto it.
pub fn write(args: PoofWriteArgs) -> Result<(), Failure> {
    let parts = disk::read_gpt(&read_head(&args.image)?)?;
    let layout = disk::fit(&parts, args.size)?;
    let total_sectors = args.size / SECTOR;
    let mut urandom = fs::File::open("/dev/urandom")?;
    let tables = disk::tables(&layout.parts, total_sectors, || {
        let mut b = [0u8; 16];
        urandom
            .read_exact(&mut b)
            .expect("/dev/urandom always reads");
        b
    });

    let mut image = fs::File::open(&args.image)?;
    let mut out = fs::OpenOptions::new()
        .write(true)
        .open(&args.device)
        .map_err(|e| {
            Failure(format!(
                "Could not open {} for writing: {e}",
                args.device.display()
            ))
        })?;
    // Clear any old partition table first, so a half-written drive never
    // looks like a finished one.
    out.write_all(&vec![0u8; tables.head.len()])?;
    out.flush()?;

    let mut copied = 0u64;
    for (from, to) in &layout.copies {
        copied += copy_data(
            &mut image,
            from.offset(),
            from.bytes(),
            &mut out,
            to.offset(),
        )?;
    }
    out.seek(SeekFrom::Start(tables.tail_offset))?;
    out.write_all(&tables.tail)?;
    out.seek(SeekFrom::Start(0))?;
    out.write_all(&tables.head)?;
    out.sync_all()?;
    eprintln!(
        "{}",
        style::err().paint(
            Role::Dim,
            &format!("Wrote {:.1} GB of system data.", copied as f64 / 1e9)
        )
    );
    Ok(())
}

/// Copies only the parts of a range that hold data (skipping holes in the
/// sparse image). Returns the bytes copied.
fn copy_data(
    src: &mut fs::File,
    from: u64,
    len: u64,
    dst: &mut fs::File,
    to: u64,
) -> Result<u64, Failure> {
    let end = from + len;
    let mut buf = vec![0u8; 4 << 20];
    let mut pos = from;
    let mut copied = 0;
    while pos < end {
        let (data, hole) = next_data(src, pos, end);
        if data >= end {
            break;
        }
        let mut at = data;
        while at < hole {
            let n = buf.len().min((hole - at) as usize);
            src.seek(SeekFrom::Start(at))?;
            src.read_exact(&mut buf[..n])?;
            dst.seek(SeekFrom::Start(to + (at - from)))?;
            dst.write_all(&buf[..n])?;
            at += n as u64;
            copied += n as u64;
        }
        pos = hole;
    }
    Ok(copied)
}

/// The next data extent at or after `pos`, as (start, end), clamped to
/// `end` and rounded out to whole sectors for raw drives.
#[cfg(unix)]
fn next_data(file: &fs::File, pos: u64, end: u64) -> (u64, u64) {
    use std::os::fd::AsRawFd;
    // The numbers differ by platform: Linux has DATA 3 and HOLE 4, Apple
    // has them the other way around.
    #[cfg(target_vendor = "apple")]
    const SEEK_HOLE: libc::c_int = 3;
    #[cfg(target_vendor = "apple")]
    const SEEK_DATA: libc::c_int = 4;
    #[cfg(not(target_vendor = "apple"))]
    const SEEK_DATA: libc::c_int = 3;
    #[cfg(not(target_vendor = "apple"))]
    const SEEK_HOLE: libc::c_int = 4;
    let fd = file.as_raw_fd();
    // SAFETY: lseek on a file we own. It only moves the file offset, which
    // copy_data sets again before every read.
    let data = unsafe { libc::lseek(fd, pos as libc::off_t, SEEK_DATA) };
    if data < 0 {
        // No more data (ENXIO), or the filesystem does not report holes:
        // treat the rest as data only in the second case.
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENXIO) {
            (end, end)
        } else {
            (pos, end)
        };
    }
    let data = (data as u64 / SECTOR * SECTOR).max(pos);
    let hole = unsafe { libc::lseek(fd, data as libc::off_t, SEEK_HOLE) };
    let hole = if hole < 0 {
        end
    } else {
        (hole as u64).div_ceil(SECTOR) * SECTOR
    };
    (data.min(end), hole.min(end))
}

#[cfg(not(unix))]
fn next_data(_file: &fs::File, pos: u64, end: u64) -> (u64, u64) {
    (pos, end)
}

// ---------------------------------------------------------------------------
// ~/.ssh/config

/// Adds (or replaces) a clearly marked block for this Mac at the top of
/// ~/.ssh/config, so it wins over any `Host *` settings below it.
fn add_ssh_host(name: &str, user: &str, identities: &[PathBuf]) -> Result<(), Failure> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let dir = home.join(".ssh");
    fs::create_dir_all(&dir)?;
    let path = dir.join("config");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let updated = ssh_config_with(&existing, name, user, identities);
    fs::write(&path, updated)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// The ssh config text with this Mac's block added or replaced.
pub fn ssh_config_with(existing: &str, name: &str, user: &str, identities: &[PathBuf]) -> String {
    let start = format!("# muxtra: {name}");
    let end = format!("# end muxtra: {name}");
    let mut block = format!(
        "{start}\n# Added by muxtra poof. Muxtra only changes the lines between these two markers.\nHost {name}\n  HostName {name}.local\n  User {user}\n"
    );
    for id in identities {
        block.push_str(&format!("  IdentityFile {}\n", id.display()));
    }
    block.push_str(&format!("{end}\n"));

    // Drop an older copy of this block, keep everything else as it was.
    let mut kept = String::new();
    let mut skipping = false;
    for line in existing.lines() {
        if line.trim() == start {
            skipping = true;
            continue;
        }
        if skipping {
            if line.trim() == end {
                skipping = false;
            }
            continue;
        }
        kept.push_str(line);
        kept.push('\n');
    }
    let kept = kept.trim_start_matches('\n');
    if kept.is_empty() {
        block
    } else {
        format!("{block}\n{kept}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_block_is_added_on_top_and_replaced() {
        let ids = vec![PathBuf::from("/home/me/.ssh/id_ed25519")];
        let first = ssh_config_with("Host *\n  User someone\n", "agent-box", "me", &ids);
        assert!(first.starts_with("# muxtra: agent-box\n"), "{first}");
        assert!(first.contains("Host agent-box\n  HostName agent-box.local\n  User me\n  IdentityFile /home/me/.ssh/id_ed25519\n"));
        assert!(first.ends_with("Host *\n  User someone\n"), "{first}");
        let again = ssh_config_with(&first, "agent-box", "admin", &[]);
        assert_eq!(again.matches("# muxtra: agent-box").count(), 1, "{again}");
        assert!(again.contains("User admin"));
        assert!(!again.contains("IdentityFile"));
        assert!(again.ends_with("Host *\n  User someone\n"));
    }

    #[test]
    fn empty_config_gets_just_the_block() {
        let text = ssh_config_with("", "lab", "me", &[]);
        assert!(text.starts_with("# muxtra: lab\n") && text.ends_with("# end muxtra: lab\n"));
    }
}
