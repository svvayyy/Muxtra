# Muxtra

A Linux base for Intel Macs, built for AI agents.

Muxtra handles the hard part of running Linux on a Mac (drivers, firmware, and model-specific quirks) and gives you a clean, modular base to build your own OS on top of. It is designed so that an AI coding agent can change it safely, and so that you can trust the result without reading every line of code.

> **Status:** early development. There is nothing to install yet. The first release, **Muxtra 1.0 "Aphelion"**, targets Intel Macs.

## Goals

- **Mac hardware, handled.** A per-model hardware database and tested drivers for Intel Macs, including T1 and T2 models.
- **One manifest.** A single file describes the whole system: the target Mac, the modules, and what runs at boot.
- **Swappable modules.** Every module lives in its own folder with a clear contract: what it provides, what it needs, and how it is tested.
- **Proof, not diffs.** One command builds the system, boots it in a virtual machine, and reports what works in plain English.
- **Hard to brick.** A/B boot with automatic rollback. Risky modules are locked until you unlock them on purpose.

## Not yet

- Apple Silicon support. It is planned after the Intel release.
- Installers, images, or anything else you can download.

## License

Muxtra's own code is dual licensed under [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at your option. Linux kernel patches are licensed under GPL-2.0, the same as the kernel itself.
