//! `muxtra build`: turn muxtra.toml into a disk image for an Intel Mac,
//! inside a hidden Debian VM.

use crate::host::{self, Arch};
use crate::style::{self, Role};
use crate::{Failure, ManifestArgs, files, keys};
use clap::{Args, ValueEnum};
use std::fs;
use std::path::Path;
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

pub fn run(args: BuildArgs) -> Result<(), Failure> {
    let (path, manifest) = files::load_manifest(&args.manifest.manifest)?;
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .to_path_buf();

    let ssh_keys = if manifest
        .modules
        .remote
        .contains(&muxtra_manifest::Remote::Ssh)
    {
        keys::resolve(&manifest.user.ssh_keys)?
    } else {
        Vec::new()
    };
    let password_hash = if manifest.user.password {
        files::read_password_hash(&dir)?
    } else {
        None
    };
    let plan = muxtra_build::plan(
        &manifest,
        &muxtra_build::Inputs {
            ssh_keys,
            password_hash,
        },
    )?;
    if args.print_config {
        print!("{}", plan.config_sh);
        return Ok(());
    }
    if args.builder == Builder::Docker {
        return Err(Failure(
            "The Docker builder is not ready yet. Leave out --builder to use Muxtra's own builder."
                .to_string(),
        ));
    }

    let o = style::out();
    let arch = Arch::host();
    let qemu = host::ensure_qemu(arch, args.yes)?;
    let base = host::builder_image(&manifest.base.debian, arch)?;

    // Fresh scratch space for this build, inside build/ which git ignores.
    let build_dir = dir.join("build");
    let work = build_dir.join(".work");
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(work.join("seed"))?;
    files::ensure_gitignored(&dir, "build/")?;

    let image = build_dir.join(format!("{}.img", manifest.system.name));
    let partial = build_dir.join(format!("{}.img.partial", manifest.system.name));
    let _ = fs::remove_file(&partial);
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
        muxtra_build::user_data(&plan.config_sh),
    )?;
    fs::write(
        work.join("seed/meta-data"),
        muxtra_build::meta_data(&instance),
    )?;
    let seed = work.join("seed.iso");
    host::make_seed_iso(&work.join("seed"), &seed)?;

    println!(
        "{} {} for {} {}",
        o.paint(Role::Accent, "Building"),
        o.paint(Role::Value, &manifest.system.name),
        o.paint(Role::Value, &manifest.system.mac),
        o.paint(
            Role::Dim,
            "in Muxtra's hidden builder. The first build takes a few minutes."
        ),
    );

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
            println!(
                "  {} {} {}",
                o.paint(Role::Dim, &clock(started.elapsed())),
                o.paint(Role::Accent, &format!("{n}/{total}")),
                text
            );
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
    let size = progress
        .size_mb
        .map(|mb| format!(", system uses {:.1} GB", mb as f64 / 1024.0))
        .unwrap_or_default();
    println!(
        "\n{} Built {} in {}{}",
        o.paint(Role::Ok, "✓"),
        o.paint(Role::Cmd, &image.display().to_string()),
        clock(started.elapsed()),
        o.paint(Role::Dim, &size)
    );
    println!(
        "\n{} {} {}",
        o.paint(Role::Accent, "Next"),
        o.paint(Role::Dim, "→"),
        o.paint(Role::Cmd, "muxtra check")
    );
    Ok(())
}

/// Elapsed time as m:ss.
fn clock(d: Duration) -> String {
    let s = d.as_secs();
    format!("{}:{:02}", s / 60, s % 60)
}
