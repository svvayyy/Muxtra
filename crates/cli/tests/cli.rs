//! End-to-end tests: run the real `muxtra` binary like an agent would, with
//! no terminal attached, and check what it writes and says.

use muxtra_manifest::{Manifest, Network, Remote};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

fn muxtra(dir: &Path, args: &[&str], stdin: Option<&str>) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_muxtra"))
        .args(args)
        .current_dir(dir)
        .env_remove("FORCE_COLOR")
        .env_remove("NO_COLOR")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("muxtra runs");
    if let Some(input) = stdin {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
    } else {
        drop(child.stdin.take());
    }
    child.wait_with_output().unwrap()
}

fn text(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

fn read_manifest(dir: &Path) -> (String, Manifest) {
    let raw = fs::read_to_string(dir.join("muxtra.toml")).expect("muxtra.toml exists");
    let parsed = Manifest::parse(&raw).expect("written manifest is valid");
    (raw, parsed)
}

#[test]
fn new_with_defaults_writes_the_agent_starter() {
    let tmp = tempfile::tempdir().unwrap();
    let out = muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None);
    assert!(out.status.success(), "{}", text(&out));
    let (raw, m) = read_manifest(tmp.path());
    assert_eq!(m.system.name, "agent-box");
    assert_eq!(m.system.mac, "iMac14,4");
    assert!(!m.user.password);
    assert_eq!(
        m.modules.remote,
        vec![Remote::Ssh, Remote::Mosh, Remote::Tailscale]
    );
    // Comments from the starter survive and stay lined up.
    assert!(
        raw.contains("name = \"agent-box\"         # find it with `ssh agent-box`"),
        "{raw}"
    );
    assert!(
        raw.contains("mac  = \"iMac14,4\"          # Mac model"),
        "{raw}"
    );
    // This iMac's Thunderbolt chip has no Linux driver, so it is left out.
    assert_eq!(m.modules.network, vec![Network::Ethernet, Network::Wifi]);
    assert!(
        raw.contains("# no thunderbolt: this Mac's chip has no Linux driver"),
        "{raw}"
    );
    let said = text(&out);
    assert!(
        said.contains("Thunderbolt networking is left out"),
        "{said}"
    );
    assert!(said.contains("No one was at the keyboard"), "{said}");
    assert!(said.contains("muxtra passwd"), "{said}");
    assert!(said.contains("includes SFTP"), "{said}");
    assert!(!tmp.path().join("muxtra.secrets").exists());
}

#[test]
fn new_keeps_thunderbolt_where_it_works() {
    let tmp = tempfile::tempdir().unwrap();
    let out = muxtra(tmp.path(), &["new", "--mac", "MacBookPro13,3"], None);
    assert!(out.status.success(), "{}", text(&out));
    let (raw, m) = read_manifest(tmp.path());
    assert!(m.modules.network.contains(&Network::Thunderbolt), "{raw}");
    assert!(
        raw.contains("# thunderbolt: a rescue cable to another Mac"),
        "{raw}"
    );
    assert!(!text(&out).contains("left out"));
}

#[test]
fn new_base_with_a_name() {
    let tmp = tempfile::tempdir().unwrap();
    let out = muxtra(
        tmp.path(),
        &[
            "new",
            "--starter",
            "base",
            "--name",
            "lab",
            "--mac",
            "Macmini8,1",
        ],
        None,
    );
    assert!(out.status.success(), "{}", text(&out));
    let (raw, m) = read_manifest(tmp.path());
    assert_eq!(m.system.name, "lab");
    assert_eq!(m.modules.remote, vec![Remote::Ssh]);
    assert!(m.modules.tools.is_empty());
    assert!(
        raw.contains("name = \"lab\"               # find it with `ssh lab` or lab.local"),
        "{raw}"
    );
    assert!(
        raw.contains("mac  = \"Macmini8,1\"        # Mac model"),
        "{raw}"
    );
}

#[test]
fn new_into_a_folder_that_does_not_exist_yet() {
    let tmp = tempfile::tempdir().unwrap();
    let out = muxtra(tmp.path(), &["new", "box", "--mac", "iMac14,4"], None);
    assert!(out.status.success(), "{}", text(&out));
    read_manifest(&tmp.path().join("box"));
}

#[test]
fn new_will_not_overwrite_without_force() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(
        muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None)
            .status
            .success()
    );
    let again = muxtra(
        tmp.path(),
        &["new", "--mac", "iMac14,4", "--name", "other"],
        None,
    );
    assert!(!again.status.success());
    assert!(text(&again).contains("--force"), "{}", text(&again));
    let forced = muxtra(
        tmp.path(),
        &["new", "--mac", "iMac14,4", "--name", "other", "--force"],
        None,
    );
    assert!(forced.status.success(), "{}", text(&forced));
    assert_eq!(read_manifest(tmp.path()).1.system.name, "other");
}

#[test]
fn new_rejects_bad_input_in_plain_english() {
    let tmp = tempfile::tempdir().unwrap();
    let bad_name = muxtra(
        tmp.path(),
        &["new", "--mac", "iMac14,4", "--name", "My Mac"],
        None,
    );
    assert!(!bad_name.status.success());
    assert!(
        text(&bad_name).contains("lowercase letters"),
        "{}",
        text(&bad_name)
    );
    let bad_mac = muxtra(tmp.path(), &["new", "--mac", "iMac 2014"], None);
    assert!(!bad_mac.status.success());
    assert!(
        text(&bad_mac).contains("sysctl -n hw.model"),
        "{}",
        text(&bad_mac)
    );
    assert!(!tmp.path().join("muxtra.toml").exists());
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
fn new_on_apple_silicon_asks_for_the_target_mac() {
    let tmp = tempfile::tempdir().unwrap();
    let out = muxtra(tmp.path(), &["new"], None);
    assert!(!out.status.success());
    let said = text(&out);
    assert!(
        said.contains("Apple Silicon") && said.contains("--mac"),
        "{said}"
    );
}

#[test]
fn password_from_stdin_is_hashed_and_kept_out_of_git() {
    let tmp = tempfile::tempdir().unwrap();
    let out = muxtra(
        tmp.path(),
        &["new", "--mac", "iMac14,4", "--password-stdin"],
        Some("correct horse battery\n"),
    );
    assert!(out.status.success(), "{}", text(&out));
    let (raw, m) = read_manifest(tmp.path());
    assert!(m.user.password);
    assert!(
        !raw.contains("correct horse"),
        "password leaked into muxtra.toml"
    );
    let secrets = fs::read_to_string(tmp.path().join("muxtra.secrets")).unwrap();
    assert!(secrets.contains("password_hash = \"$6$"), "{secrets}");
    assert!(
        !secrets.contains("correct horse"),
        "password stored in plain text"
    );
    let ignore = fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
    assert!(ignore.lines().any(|l| l == "muxtra.secrets"), "{ignore}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(tmp.path().join("muxtra.secrets"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn passwd_needs_a_person_or_a_pipe() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(
        muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None)
            .status
            .success()
    );
    let out = muxtra(tmp.path(), &["passwd"], None);
    assert!(!out.status.success());
    assert!(text(&out).contains("--password-stdin"), "{}", text(&out));
}

#[test]
fn passwd_sets_then_removes() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(
        muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None)
            .status
            .success()
    );

    let set = muxtra(
        tmp.path(),
        &["passwd", "--password-stdin"],
        Some("hunter2\n"),
    );
    assert!(set.status.success(), "{}", text(&set));
    let (raw, m) = read_manifest(tmp.path());
    assert!(m.user.password);
    assert!(
        raw.contains("# `muxtra passwd` sets one"),
        "comment lost: {raw}"
    );
    assert!(tmp.path().join("muxtra.secrets").exists());

    let removed = muxtra(tmp.path(), &["passwd", "--remove"], None);
    assert!(removed.status.success(), "{}", text(&removed));
    assert!(!read_manifest(tmp.path()).1.user.password);
    assert!(!tmp.path().join("muxtra.secrets").exists());
}

#[test]
fn missing_manifest_points_to_new() {
    let tmp = tempfile::tempdir().unwrap();
    let out = muxtra(tmp.path(), &["build"], None);
    assert!(!out.status.success());
    assert!(text(&out).contains("muxtra new"), "{}", text(&out));
}

#[test]
fn agents_get_plain_text() {
    let tmp = tempfile::tempdir().unwrap();
    let out = muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None);
    assert!(out.status.success(), "{}", text(&out));
    assert!(
        !text(&out).contains('\x1b'),
        "color codes leaked: {:?}",
        text(&out)
    );
    assert!(text(&out).contains("Next → muxtra build"), "{}", text(&out));
}

#[test]
fn people_get_colors_in_both_themes() {
    for (theme, ice) in [("dark", "38;2;143;208;245"), ("light", "38;2;31;111;168")] {
        let tmp = tempfile::tempdir().unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_muxtra"))
            .args(["new", "--mac", "iMac14,4"])
            .current_dir(tmp.path())
            .env("FORCE_COLOR", "1")
            .env("COLORTERM", "truecolor")
            .env("MUXTRA_THEME", theme)
            .env_remove("NO_COLOR")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let said = text(&out);
        assert!(
            said.contains(&format!("\x1b[{ice}miMac14,4")),
            "{theme}: {said:?}"
        );
        // The command to type is bold, without its backticks.
        assert!(said.contains("passwd\x1b[0m"), "{theme}: {said:?}");
    }
}

#[test]
fn manifest_problems_name_the_field() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(
        muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None)
            .status
            .success()
    );
    let path = tmp.path().join("muxtra.toml");
    let broken = fs::read_to_string(&path)
        .unwrap()
        .replace("\"agent-box\"", "\"Agent Box\"");
    fs::write(&path, broken).unwrap();
    let out = muxtra(tmp.path(), &["check"], None);
    assert!(!out.status.success());
    let said = text(&out);
    assert!(said.contains("✗ muxtra.toml has 1 problem:"), "{said}");
    assert!(said.contains("  system.name · "), "{said}");
}

fn muxtra_with_home(dir: &Path, home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_muxtra"))
        .args(args)
        .current_dir(dir)
        .env("HOME", home)
        .env_remove("FORCE_COLOR")
        .env_remove("NO_COLOR")
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

#[test]
fn build_uses_your_existing_ssh_key() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join(".ssh")).unwrap();
    let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExistingKey me@laptop";
    fs::write(home.path().join(".ssh/id_ed25519.pub"), format!("{key}\n")).unwrap();
    assert!(
        muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None)
            .status
            .success()
    );
    let out = muxtra_with_home(tmp.path(), home.path(), &["build", "--print-config"]);
    assert!(out.status.success(), "{}", text(&out));
    let config = String::from_utf8_lossy(&out.stdout);
    assert!(config.contains(&format!("SSH_KEYS=('{key}')")), "{config}");
    assert!(config.contains("NODE_MAJOR='26'"), "{config}");
}

#[test]
fn build_makes_a_key_when_you_have_none() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    assert!(
        muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None)
            .status
            .success()
    );
    let out = muxtra_with_home(tmp.path(), home.path(), &["build", "--print-config"]);
    assert!(out.status.success(), "{}", text(&out));
    let made = fs::read_to_string(home.path().join(".ssh/id_ed25519.pub")).unwrap();
    let config = String::from_utf8_lossy(&out.stdout);
    assert!(config.contains(made.trim()), "{config}");
    // The note about the new key goes to stderr, never into the config.
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("made one"),
        "{}",
        text(&out)
    );
    assert!(!config.contains("made one"));
}

#[test]
fn build_explains_what_it_cannot_build_yet() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    assert!(
        muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None)
            .status
            .success()
    );
    let path = tmp.path().join("muxtra.toml");
    let text_now = fs::read_to_string(&path).unwrap();
    fs::write(
        &path,
        text_now.replace("\"tailscale\"]", "\"tailscale\", \"ngrok\"]"),
    )
    .unwrap();
    let out = muxtra_with_home(tmp.path(), home.path(), &["build", "--print-config"]);
    assert!(!out.status.success());
    assert!(text(&out).contains("cannot be built yet"), "{}", text(&out));
}

#[test]
fn build_needs_the_password_hash_it_was_promised() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    assert!(
        muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None)
            .status
            .success()
    );
    let path = tmp.path().join("muxtra.toml");
    let text_now = fs::read_to_string(&path).unwrap();
    fs::write(
        &path,
        text_now.replace("password = false", "password = true"),
    )
    .unwrap();
    let out = muxtra_with_home(tmp.path(), home.path(), &["build", "--print-config"]);
    assert!(!out.status.success());
    assert!(text(&out).contains("muxtra passwd"), "{}", text(&out));
}

#[test]
fn poof_asks_agents_to_name_the_drive() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    assert!(
        muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None)
            .status
            .success()
    );
    for command in ["poof", "flash"] {
        let out = muxtra_with_home(tmp.path(), home.path(), &[command]);
        assert!(!out.status.success());
        let said = text(&out);
        assert!(
            said.contains("--disk") && said.contains("--yes"),
            "{command}: {said}"
        );
        // Nothing was built while finding that out.
        assert!(!tmp.path().join("build").exists());
    }
    let out = muxtra_with_home(
        tmp.path(),
        home.path(),
        &["poof", "--disk", "disk0", "--yes"],
    );
    assert!(!out.status.success());
    assert!(
        text(&out).contains("never to the disk it runs from"),
        "{}",
        text(&out)
    );
}

#[test]
fn poof_write_fits_the_image_onto_a_smaller_drive() {
    use muxtra_build::disk::{self, Part, SECTOR};
    use std::io::{Seek, SeekFrom};
    const GIB: u64 = 1024 * 1024 * 1024;
    let tmp = tempfile::tempdir().unwrap();

    // A sparse 10 GiB image laid out like builder.sh makes it, with a
    // marker at the start of each partition.
    let part = |name: &str, t: &str, first: u64, bytes: u64| Part {
        name: name.into(),
        type_guid: disk::guid(t),
        first,
        last: first + bytes / SECTOR - 1,
    };
    let esp = part("muxtra-efi", disk::ESP_TYPE, 2048, 512 << 20);
    let a = part(
        "muxtra-root-a",
        disk::ROOT_X86_64_TYPE,
        esp.last + 1,
        4 * GIB,
    );
    let b = part("muxtra-root-b", disk::ROOT_X86_64_TYPE, a.last + 1, 4 * GIB);
    let home_bytes = (10 * GIB - (1 << 20)) - (b.last + 1) * SECTOR;
    let home = part("muxtra-home", disk::HOME_TYPE, b.last + 1, home_bytes);
    let parts = vec![esp.clone(), a.clone(), b, home.clone()];
    let image_path = tmp.path().join("image.img");
    let mut image = fs::File::create(&image_path).unwrap();
    image.set_len(10 * GIB).unwrap();
    let mut n = 0u8;
    let t = disk::tables(&parts, 10 * GIB / SECTOR, || {
        n += 1;
        [n; 16]
    });
    image.write_all(&t.head).unwrap();
    for (p, mark) in [(&esp, b"ESP-MARK"), (&a, b"ROOTMARK"), (&home, b"HOMEMARK")] {
        image.seek(SeekFrom::Start(p.offset() + 4096)).unwrap();
        image.write_all(mark).unwrap();
    }
    drop(image);

    // An "8 GB" drive, as a file.
    let size = 7_800_000_000u64;
    let drive = tmp.path().join("drive.img");
    fs::File::create(&drive).unwrap().set_len(size).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_muxtra"))
        .args(["poof-write", "--image"])
        .arg(&image_path)
        .arg("--device")
        .arg(&drive)
        .args(["--size", &size.to_string()])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out));

    let mut written = fs::File::open(&drive).unwrap();
    let mut read_at = |offset: u64, len: usize| {
        let mut buf = vec![0u8; len];
        written.seek(SeekFrom::Start(offset)).unwrap();
        std::io::Read::read_exact(&mut written, &mut buf).unwrap();
        buf
    };
    let got = disk::read_gpt(&read_at(0, 34 * SECTOR as usize)).unwrap();
    let names: Vec<&str> = got.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["muxtra-efi", "muxtra-root-a", "muxtra-home"]);
    for (name, mark) in [
        ("muxtra-efi", b"ESP-MARK"),
        ("muxtra-root-a", b"ROOTMARK"),
        ("muxtra-home", b"HOMEMARK"),
    ] {
        let p = got.iter().find(|p| p.name == name).unwrap();
        assert_eq!(
            &read_at(p.offset() + 4096, 8),
            mark,
            "{name} data is not where its partition starts"
        );
    }
    // Backup partition table at the very end.
    let last_sector = (size / SECTOR - 1) * SECTOR;
    assert_eq!(&read_at(last_sector, 8), b"EFI PART");
    // Only real data was copied, not 10 GB of zeros.
    assert!(text(&out).contains("Wrote 0.0 GB"), "{}", text(&out));
}

fn secrets_text(dir: &Path) -> String {
    fs::read_to_string(dir.join("muxtra.secrets")).unwrap_or_default()
}

#[test]
fn new_saves_wifi_as_a_key_not_a_password() {
    let tmp = tempfile::tempdir().unwrap();
    let out = muxtra(
        tmp.path(),
        &[
            "new",
            "--mac",
            "iMac14,4",
            "--wifi-ssid",
            "IEEE",
            "--wifi-password-stdin",
        ],
        Some("password\n"),
    );
    assert!(out.status.success(), "{}", text(&out));
    let secrets = secrets_text(tmp.path());
    assert!(secrets.contains("ssid = \"IEEE\""), "{secrets}");
    // The IEEE 802.11i test key for passphrase "password" on "IEEE".
    assert!(
        secrets
            .contains("psk = \"f42c6fc52df0ebef9ebb4b90b38a5f902e83fe1b135a70e23aed762e9710a12e\""),
        "{secrets}"
    );
    assert!(
        !secrets.contains("= \"password\""),
        "plain password stored: {secrets}"
    );
    assert!(text(&out).contains("Wi-Fi     IEEE"), "{}", text(&out));
    let ignore = fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
    assert!(ignore.lines().any(|l| l == "muxtra.secrets"));
}

#[test]
fn new_without_wifi_says_how_to_add_it() {
    let tmp = tempfile::tempdir().unwrap();
    let out = muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None);
    assert!(out.status.success(), "{}", text(&out));
    assert!(text(&out).contains("muxtra wifi add"), "{}", text(&out));
    assert!(!tmp.path().join("muxtra.secrets").exists());
}

#[test]
fn wifi_add_list_remove_and_passwd_keep_each_other() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(
        muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None)
            .status
            .success()
    );
    let add = muxtra(
        tmp.path(),
        &["wifi", "add", "Home Net", "--password-stdin"],
        Some("correcthorse\n"),
    );
    assert!(add.status.success(), "{}", text(&add));
    let add2 = muxtra(
        tmp.path(),
        &["wifi", "add", "Café", "--password-stdin"],
        Some("anotherpass1\n"),
    );
    assert!(add2.status.success(), "{}", text(&add2));
    let list = muxtra(tmp.path(), &["wifi", "list"], None);
    assert_eq!(
        String::from_utf8_lossy(&list.stdout)
            .lines()
            .collect::<Vec<_>>(),
        ["Home Net", "Café"]
    );

    // Setting a password must not erase the Wi-Fi networks, and back.
    assert!(
        muxtra(
            tmp.path(),
            &["passwd", "--password-stdin"],
            Some("hunter22\n")
        )
        .status
        .success()
    );
    let secrets = secrets_text(tmp.path());
    assert!(
        secrets.contains("password_hash")
            && secrets.contains("Home Net")
            && secrets.contains("Café"),
        "{secrets}"
    );
    assert!(
        !secrets.contains("correcthorse") && !secrets.contains("hunter22"),
        "{secrets}"
    );

    let rm = muxtra(tmp.path(), &["wifi", "remove", "Home Net"], None);
    assert!(rm.status.success(), "{}", text(&rm));
    let secrets = secrets_text(tmp.path());
    assert!(
        !secrets.contains("Home Net")
            && secrets.contains("Café")
            && secrets.contains("password_hash"),
        "{secrets}"
    );
    let missing = muxtra(tmp.path(), &["wifi", "remove", "Nope"], None);
    assert!(!missing.status.success());

    // Without a keyboard or a pipe, wifi add explains itself.
    let lonely = muxtra(tmp.path(), &["wifi", "add"], None);
    assert!(!lonely.status.success());
    assert!(
        text(&lonely).contains("--password-stdin"),
        "{}",
        text(&lonely)
    );
}

#[test]
fn build_config_carries_the_wifi_networks() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    assert!(
        muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None)
            .status
            .success()
    );
    assert!(
        muxtra(
            tmp.path(),
            &["wifi", "add", "Café", "--password-stdin"],
            Some("anotherpass1\n")
        )
        .status
        .success()
    );
    let out = muxtra_with_home(tmp.path(), home.path(), &["build", "--print-config"]);
    assert!(out.status.success(), "{}", text(&out));
    let config = String::from_utf8_lossy(&out.stdout);
    assert!(config.contains("WITH_WIFI='1'"), "{config}");
    assert!(
        config.contains("WIFI_FILES=('=436166c3a9.psk')"),
        "{config}"
    );
    assert!(
        config.contains("WIFI_CONFIGS=('[Security]\nPreSharedKey="),
        "{config}"
    );
}
