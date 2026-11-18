//! End-to-end tests: run the real `muxtra` binary like an agent would, with
//! no terminal attached, and check what it writes and says.

use muxtra_manifest::{Manifest, Remote};
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
fn new_with_defaults_writes_agent_box() {
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
    let said = text(&out);
    assert!(said.contains("No one was at the keyboard"), "{said}");
    assert!(said.contains("muxtra passwd"), "{said}");
    assert!(said.contains("includes SFTP"), "{said}");
    assert!(!tmp.path().join("muxtra.secrets").exists());
}

#[test]
fn new_blank_with_a_name() {
    let tmp = tempfile::tempdir().unwrap();
    let out = muxtra(
        tmp.path(),
        &[
            "new",
            "--starter",
            "blank",
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
fn unfinished_commands_still_check_the_manifest() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(
        muxtra(tmp.path(), &["new", "--mac", "iMac14,4"], None)
            .status
            .success()
    );
    for command in ["poof", "flash"] {
        let out = muxtra(tmp.path(), &[command], None);
        let said = text(&out);
        assert!(
            !out.status.success(),
            "{command} should say it is not ready"
        );
        assert!(said.contains("looks good"), "{command}: {said}");
        assert!(said.contains("not ready yet"), "{command}: {said}");
    }
    fs::write(
        tmp.path().join("muxtra.toml"),
        fs::read_to_string(tmp.path().join("muxtra.toml"))
            .unwrap()
            .replace("\"iMac14,4\"", "\"iMac 2014\""),
    )
    .unwrap();
    let broken = muxtra(tmp.path(), &["check"], None);
    assert!(text(&broken).contains("system.mac"), "{}", text(&broken));
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
