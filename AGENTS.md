# AGENTS.md

Guidance for AI agents (and people) working on the Muxtra repository itself.

## What Muxtra is

A Linux base for Intel Macs, built for AI agents. A `muxtra.toml` manifest describes a whole system. The `muxtra` command turns it into a Debian image, checks it in a virtual machine, and puts it on a Mac.

## Layout

| Path | What lives there |
|---|---|
| `crates/manifest` | Reads and checks `muxtra.toml`. No disk or network access. |
| `crates/build` | Turns a manifest into settings for the builder VM, and reads its progress back. No disk or network access. |
| `crates/build/assets/builder.sh` | Runs inside the hidden Debian VM and writes the disk image. Its `MUXTRA-STEP` markers are read by the CLI. |
| `crates/cli` | The `muxtra` command: `new`, `build`, `check`, `poof` (quiet alias `flash`), `passwd`, `wifi`, `tailscale login` |
| `starters/` | Ready-made manifests that `muxtra new` copies. `agent-box` is the default. |
| `site/`, `site-src/` | muxtra.dev, deployed by GitHub Pages. Run `scripts/build-site.sh` after changing either. |
| `third_party/` | Vendored code with its own license. Do not edit without updating its README. |
| `brand/` | Icon sources and exports |

## Before you commit

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

All three must pass. CI runs them on Linux and macOS.

`muxtra build` itself needs QEMU and a few minutes, so CI does not run it. After changing `builder.sh` or the build command, run a real build and boot the image (see `muxtra check`) before committing.

## Rules

- **Plain English.** Every message a user sees says what happened or what is wrong, and what to do next, in words a non-programmer understands.
- **Never wait on a keyboard that is not there.** Every question has a flag. With no terminal attached, use the defaults and print what was chosen.
- **Passwords never touch `muxtra.toml`.** Only a hash goes in `muxtra.secrets`, which is git-ignored and readable only by its owner. Never print, log, or test with a real password.
- **Keep starters valid.** Every file in `starters/` must parse and pass the manifest checks. A test enforces this.
- **Every default can be turned off** in the manifest.
- **Small commits.** One distinct change per commit, with a message that says why.
- **This repository is public.** No personal names, emails, home network details, or machine nicknames in code, tests, docs, or commit messages. Describe test hardware by Mac model identifier.
