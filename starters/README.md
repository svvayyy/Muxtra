# Starters

Ready-made manifests that `muxtra new` copies and fills in.

| Starter | What it is |
|---|---|
| `agent` (default) | A headless Mac for you and your agents: SSH, mosh, Tailscale, git, Node, Claude Code and Codex. New Macs are named `agent-box` |
| `base` | Just the Muxtra base: Debian, Mac drivers, networking and SSH |

`muxtra new` replaces `system.name` and `system.mac`, and sets `user.password` if you choose one. Everything else is copied as written, comments included.

Every starter must parse and pass `muxtra check` with no changes. The manifest crate's tests enforce this.
