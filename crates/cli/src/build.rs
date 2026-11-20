//! `muxtra build`: turn muxtra.toml into a disk image for an Intel Mac,
//! inside a hidden Debian VM.

use crate::host::{self, Arch};
use crate::style::{self, Role, say};
use crate::{Failure, ManifestArgs, files, keys};
use clap::{Args, ValueEnum};
use muxtra_build::Plan;
use muxtra_manifest::{Manifest, Remote};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Where the build happens.
#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Builder {
    /// Muxtra's own hidden Linux VM (the default)
    Vm,
    /// Docker or OrbStack, if you have one of them
    Docker,
}

#[derive(Args)]
pub struct BuildArgs {
    #[command(flatten)]
    manifest: ManifestArgs,
    /// Say yes to installing what the build needs (QEMU)
    #[arg(long, short = 'y')]
    yes: bool,
    /// Where to build
    #[arg(long, value_enum, default_value_t = Builder::Vm)]
    builder: Builder,
    /// Print the builder settings and stop (for debugging)
    #[arg(long, hide = true)]
    print_config: bool,
}

/// Longest a build may take before Muxtra gives up on it.
const TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// A manifest with everything worked out, ready to build or check.
pub struct Prepared {
    pub manifest: Manifest,
    /// The folder holding muxtra.toml.
    pub dir: PathBuf,
    pub plan: Plan,
    /// Private keys that go with the installed public keys.
    pub identities: Vec<PathBuf>,
}

impl Prepared {
    pub fn build_dir(&self) -> PathBuf {
        self.dir.join("build")
    }

    pub fn image(&self) -> PathBuf {
        self.build_dir()
            .join(format!("{}.img", self.manifest.system.name))
    }

    fn stamp(&self) -> PathBuf {
        self.build_dir()
            .join(format!("{}.fingerprint", self.manifest.system.name))
    }

    /// Why the image needs building before it can be checked, if it does.
    pub fn needs_build(&self) -> Option<&'static str> {
        if !self.image().is_file() {
            Some("There is no image yet, so Muxtra is building first.")
        } else if !self.stamp().is_file() {
            Some(
                "Muxtra cannot tell which settings this image was built from, so it is building it again first.",
            )
        } else if !self.is_current() {
            Some(
                "muxtra.toml, your keys or your password changed since the last build, so Muxtra is building first.",
            )
        } else {
            None
        }
    }

    /// True when the image exists and was built from these exact settings.
    pub fn is_current(&self) -> bool {
        self.image().is_file()
            && fs::read_to_string(self.stamp())
                .is_ok_and(|s| s.trim() == muxtra_build::fingerprint(&self.plan))
    }
}

/// Reads the manifest, its keys and password, and plans the build.
pub fn prepare(manifest: &Path) -> Result<Prepared, Failure> {
    let (path, manifest) = files::load_manifest(manifest)?;
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .to_path_buf();
    let keys = if manifest.modules.remote.contains(&Remote::Ssh) {
        keys::resolve(&manifest.user.ssh_keys)?
    } else {
        keys::Resolved::default()
    };
    let secrets = files::read_secrets(&dir)?;
    let password_hash = if manifest.user.password {
        secrets.password_hash.clone()
    } else {
        None
    };
    let plan = muxtra_build::plan(
        &manifest,
        &muxtra_build::Inputs {
            ssh_keys: keys.public,
            password_hash,
            wifi: secrets.wifi,
        },
    )?;
    Ok(Prepared {
        manifest,
        dir,
        plan,
        identities: keys.identities,
    })
}

pub fn run(args: BuildArgs) -> Result<(), Failure> {
    let prepared = prepare(&args.manifest.manifest)?;
    if args.print_config {
        print!("{}", prepared.plan.config_sh);
        return Ok(());
    }
    if args.builder == Builder::Docker {
        return Err(Failure(
            "The Docker builder is not ready yet. Leave out --builder to use Muxtra's own builder."
                .to_string(),
        ));
    }
    build_image(&prepared, args.yes)?;
    let o = style::progress();
    say(&format!(
        "\n{} {} {}",
        o.paint(Role::Accent, "Next"),
        o.paint(Role::Dim, "→"),
        o.paint(Role::Cmd, "muxtra check")
    ));
    Ok(())
}

/// Builds the image in the hidden builder VM. Returns its path.
pub fn build_image(p: &Prepared, yes: bool) -> Result<PathBuf, Failure> {
    let manifest = &p.manifest;
    let o = style::progress();
    let arch = Arch::host();
    let qemu = host::ensure_qemu(arch, yes)?;
    let base = host::builder_image(&manifest.base.debian, arch)?;

    // Fresh scratch space for this build, inside build/ which git ignores.
    let build_dir = p.build_dir();
    let work = build_dir.join(".work");
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(work.join("seed"))?;
    files::ensure_gitignored(&p.dir, "build/")?;

    let image = p.image();
    let partial = build_dir.join(format!("{}.img.partial", manifest.system.name));
    let _ = fs::remove_file(&partial);
    let _ = fs::remove_file(p.stamp());
    fs::File::create(&partial)?.set_len(muxtra_build::IMAGE_BYTES)?;

    let overlay = work.join("builder.qcow2");
    let status = Command::new(&qemu.img)
        .args(["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b"])
        .arg(&base)
        .arg(&overlay)
        .arg("16G")
        .status()?;
    if !status.success() {
        return Err(Failure("Could not set up the builder's disk.".to_string()));
    }
    let instance = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string();
    fs::write(
        work.join("seed/user-data"),
        muxtra_build::user_data(&p.plan.config_sh),
    )?;
    fs::write(
        work.join("seed/meta-data"),
        muxtra_build::meta_data(&instance),
    )?;
    let seed = work.join("seed.iso");
    host::make_seed_iso(&work.join("seed"), &seed)?;

    say(&format!(
        "{} {} for {} {}",
        o.paint(Role::Accent, "Building"),
        o.paint(Role::Value, &manifest.system.name),
        o.paint(Role::Value, &manifest.system.mac),
        o.paint(
            Role::Dim,
            "in Muxtra's hidden builder. The first build takes a few minutes."
        ),
    ));

    let console = work.join("console.log");
    let cpus = std::thread::available_parallelism().map_or(2, |n| n.get().min(4));
    let accel = host::accelerator();
    let mut cmd = Command::new(&qemu.system);
    match arch {
        Arch::Arm64 => {
            cmd.args(["-machine", "virt", "-cpu"])
                .arg(if accel == "tcg" { "max" } else { "host" })
                .arg("-bios")
                .arg(qemu.share.join("edk2-aarch64-code.fd"));
        }
        Arch::Amd64 => {
            cmd.args(["-machine", "q35", "-cpu"])
                .arg(if accel == "tcg" { "max" } else { "host" });
        }
    }
    cmd.args(["-accel", accel, "-smp", &cpus.to_string(), "-m", "3072"])
        .args(["-display", "none", "-monitor", "none", "-serial"])
        .arg(format!("file:{}", console.display()))
        .arg("-drive")
        .arg(format!("if=virtio,file={},format=qcow2", overlay.display()))
        .arg("-drive")
        .arg(format!(
            "if=virtio,file={},format=raw,readonly=on",
            seed.display()
        ))
        .arg("-drive")
        .arg(format!(
            "if=none,id=out,file={},format=raw",
            partial.display()
        ))
        .args(["-device", "virtio-blk-pci,drive=out,serial=muxtra-out"])
        .args(["-nic", "user,model=virtio-net-pci"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(fs::File::create(work.join("qemu.log"))?);
    let mut vm = cmd
        .spawn()
        .map_err(|e| Failure(format!("Could not start the builder VM: {e}")))?;

    let started = Instant::now();
    let mut shown_step = 0;
    let progress = loop {
        std::thread::sleep(Duration::from_millis(500));
        let log = fs::read(&console)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        let progress = muxtra_build::read_progress(&log);
        if let Some((n, total, text)) = &progress.step
            && *n != shown_step
        {
            shown_step = *n;
            say(&format!(
                "  {} {} {}",
                o.paint(Role::Dim, &clock(started.elapsed())),
                o.paint(Role::Accent, &format!("{n}/{total}")),
                text
            ));
        }
        if progress.result.is_some() {
            break progress;
        }
        if let Some(status) = vm.try_wait()? {
            let qemu_said = fs::read_to_string(work.join("qemu.log")).unwrap_or_default();
            return Err(Failure(format!(
                "The builder VM stopped before finishing ({status}). {}",
                qemu_said.lines().last().unwrap_or("")
            )));
        }
        if started.elapsed() > TIMEOUT {
            let _ = vm.kill();
            return Err(Failure(
                "The build took over an hour, so Muxtra stopped it.".to_string(),
            ));
        }
    };

    // The builder powers itself off. Give it a moment, then make sure.
    let shutdown = Instant::now();
    while vm.try_wait()?.is_none() && shutdown.elapsed() < Duration::from_secs(60) {
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = vm.kill();
    let _ = vm.wait();

    let log_path = build_dir.join("build.log");
    let _ = fs::copy(&console, &log_path);
    let log = String::from_utf8_lossy(&fs::read(&console).unwrap_or_default()).into_owned();
    let _ = fs::remove_dir_all(&work);

    if progress.result != Some(0) {
        let _ = fs::remove_file(&partial);
        let e = style::err();
        eprintln!(
            "{} The build failed. The builder said:",
            e.paint(Role::Err, "✗")
        );
        for line in muxtra_build::failure_excerpt(&log, 12) {
            eprintln!("  {}", e.paint(Role::Dim, &line));
        }
        return Err(Failure(format!(
            "The full log is in `{}`.",
            log_path.display()
        )));
    }

    fs::rename(&partial, &image)?;
    fs::write(p.stamp(), muxtra_build::fingerprint(&p.plan))?;
    let size = progress
        .size_mb
        .map(|mb| format!(", system uses {:.1} GB", mb as f64 / 1024.0))
        .unwrap_or_default();
    say(&format!(
        "\n{} Built {} in {}{}",
        o.paint(Role::Ok, "✓"),
        o.paint(Role::Cmd, &image.display().to_string()),
        clock(started.elapsed()),
        o.paint(Role::Dim, &size)
    ));
    Ok(image)
}

/// Elapsed time as m:ss.
pub fn clock(d: Duration) -> String {
    let s = d.as_secs();
    format!("{}:{:02}", s / 60, s % 60)
}
