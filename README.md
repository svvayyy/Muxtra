# Muxtra

A Linux base for Intel Macs, built for AI agents.

Muxtra handles the hard part of running Linux on a Mac (drivers, firmware, and model-specific quirks) and gives you a clean, modular base to build your own OS on top of. It is designed so that an AI coding agent can change it safely, and so that you can trust the result without reading every line of code.

> **Status:** early development. Muxtra builds, checks, and boots on real hardware, but there is no release yet. The first release, **Muxtra 1.0 "Aphelion"**, targets Intel Macs.

## What works today

- `muxtra new` starts a `muxtra.toml` from a ready-made starter.
- `muxtra build` turns it into a Debian system image in a hidden builder VM.
- `muxtra check` boots the image in a virtual Mac and reports what works in plain English. `muxtra check --real` runs the same report on the real Mac over SSH.
- `muxtra poof` puts the image on a USB stick for the Mac to boot from.
- `muxtra wifi` saves Wi-Fi networks (only the derived key is stored), and `muxtra tailscale login` signs the Mac in to Tailscale with a link.
- Every command has a plain mode for agents, and `--json` where it reports results.

Tested on real hardware: the 15-inch 2016 MacBook Pro (`MacBookPro13,3`, T1) boots from USB, joins Wi-Fi on its own, and signs in to Tailscale.

## Goals

- **Mac hardware, handled.** A per-model hardware database and tested drivers for Intel Macs, including T1 and T2 models.
- **One manifest.** A single file describes the whole system: the target Mac, the modules, and what runs at boot.
- **Swappable modules.** Every module lives in its own folder with a clear contract: what it provides, what it needs, and how it is tested.
- **Proof, not diffs.** One command builds the system, boots it in a virtual machine, and reports what works in plain English.
- **Hard to brick.** A/B boot with automatic rollback. Risky modules are locked until you unlock them on purpose.

## Not yet

- Apple Silicon support. It is planned after the Intel release.
- T2 Macs, installing to the Mac's internal drive, and A/B rollback.
- Releases, installers, or images you can download.

## License

Muxtra's own code is dual licensed under [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at your option. Linux kernel patches are licensed under GPL-2.0, the same as the kernel itself.
