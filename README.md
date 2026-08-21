<p align="center">
  <img src="https://raw.githubusercontent.com/svvayyy/Muxtra/main/website/assets/readme-header.png" alt="Muxtra — Many agents. One codebase." width="100%">
</p>

<p align="center">
  <a href="https://muxtra.dev">Website</a> ·
  <a href="#quick-start-for-people">Quick start</a> ·
  <a href="#design-and-code-lanes">Design and code lanes</a>
</p>

Muxtra lets coding agents from different providers work on the same project at the same
time. It keeps every agent isolated while it works, tracks overlapping changes, and is
able to combine their completed work into one verified result.

The repository owns the workflow. A committed project contract defines setup commands, checks, Git policy, runtime configuration, and production safeguards. Each task receives its own branch and worktree so concurrent agents do not overwrite one another's source code.

> [!IMPORTANT]
> Muxtra is currently in public beta. It combines verified
> local task branches, but does not push branches, open pull requests, or deploy releases.

## Features

- Separate branch and Git worktree for every agent task
- Existing-worktree adoption without resets or file changes
- Recorded base commits and stale-work detection
- Repository-owned setup, check, Git, and deployment policy
- Isolated local ports, process metadata, logs, and clean shutdown
- Optional Vercel Development environment injection without persisted secret values
- Shared claim registry so agents can see what every other agent intends to edit
- Claim-aware build diagnostics that match failing paths to active write claims
- Finish gate for committed, current, tested integration candidates
- Guarded composition that checks the combined result before advancing the primary branch
- Per-machine design and code lane defaults with independent providers and exact models
- Coordinated design/code teams with one isolated workspace per responsibility
- Stable managed launch adapters for Claude Code and Codex CLI
- Conversation-free agent activity tracking for managed and externally opened CLI sessions
- Portable instructions for app-based, remote, and unsupported agent clients
- Versioned machine-readable reports and a reusable programmatic core

## Install

Muxtra requires Node.js 20 or newer and Git:

```bash
npm install --global muxtra@beta
muxtra --version
```

Beta releases are published under npm's `beta` tag. Because this is Muxtra's first npm
release, npm also resolves the untagged package name to this build until a stable release
exists. Use `muxtra@beta` to stay on the intended prerelease channel, and expect the CLI
to evolve as the workflow is tested in real projects.

To build Muxtra itself from source, see [Development](#development).

## Quick start for people

You do not need to understand branches or Git worktrees. From an existing Git project
with at least one commit, set up Muxtra once and describe a task:

```bash
muxtra setup
muxtra start "Build the dashboard navigation" --agent codex
```

`muxtra setup` creates `.muxtra/project.yaml` and commits that one file so every isolated
agent receives the same workflow. For JavaScript and TypeScript projects, it detects common
`lint`, `typecheck`, `test`, and `build` scripts. If it cannot detect a check, it tells you
exactly what to add before allowing the first task to start.

Open another terminal and start a different provider on another task:

```bash
muxtra start "Add dashboard search" --agent claude
muxtra status
```

Check which supported CLIs are ready on the current computer:

```bash
muxtra agents
```

After the agents commit and run `muxtra finish`, combine every verified task:

```bash
muxtra combine
```

Muxtra builds a temporary combined result, runs its configured install and repository
checks there, and only advances the primary project when every merge and check succeeds.
Same-file conflicts, setup failures, and combined-only check failures leave the primary
project untouched. Task branches are never deleted automatically.

Muxtra generates the internal workspace names and branches. `muxtra status` shows tasks
in plain language; `muxtra status --details` exposes Git diagnostics when you need them.
Agents receive the repository workflow and task automatically.

## Design and code lanes

Muxtra can split one feature into two focused tasks: a **design lane** for UI, frontend,
responsive behavior, and accessibility; and a **code lane** for backend logic, state,
data, integrations, architecture, and tests. Each lane can use a different provider and
an exact provider model.

Set your machine-local defaults once. Omitting `--model` uses that provider's current
default model:

```bash
muxtra lanes set design --agent claude --model <claude-model>
muxtra lanes set code --agent codex --model <codex-model>
muxtra lanes
```

Then create both isolated tasks together:

```bash
muxtra team "Build account settings"
```

Muxtra prints one `muxtra launch` command for each workspace. Open those commands in
separate terminals so Claude Code and Codex retain their complete native interfaces,
including reasoning, tool calls, approvals, and conversation. When both tasks are
verified, run the exact `muxtra combine <design-task> <code-task>` command Muxtra prints.

Lane preferences live in Muxtra's local Git state and do not dirty the repository. A
team can also commit shared defaults under `lanes` in `.muxtra/project.yaml`.

## Advanced workflow

The lower-level commands remain available for agents, automation, and people who want
direct control:

`muxtra launch` starts the selected coding agent in its full interactive interface inside the isolated worktree and supplies the committed project workflow as its initial context. Muxtra coordinates workspace status without reading or storing the provider conversation. It does not create, replace, or modify `AGENTS.md`, `CLAUDE.md`, or other repository instruction files.

Include the first task when launching an agent:

```bash
muxtra launch dashboard-polish --prompt "Polish the dashboard navigation"
```

For ChatGPT, a remote OpenClaw agent, or another client that Muxtra cannot launch directly, print a portable handoff and paste it into that client:

```bash
muxtra instructions dashboard-polish --agent chatgpt
```

If you open Claude Code or Codex yourself instead of using `muxtra launch`, paste the
generated instructions into it. The instructions begin with `muxtra attach`, which lets
Muxtra reflect the session's workspace activity without reading or storing its conversation.

To register a worktree that already exists:

```bash
muxtra adopt ../existing-worktree --agent claude
```

Verify a committed workspace before handing it off, then remove it after integration:

```bash
muxtra finish dashboard-polish
muxtra remove dashboard-polish
```

`muxtra finish` runs the configured checks, verifies that the branch is clean, ahead of
its recorded base, not stale, and has no running development process. A successful run
records the exact verified commit and releases the finishing agent's claim. It does not
push, merge, or remove the workspace; `muxtra combine` performs guarded local composition.

Managed worktrees must be clean before removal, and their Git branches are retained.
Adopted worktrees are only unregistered; Muxtra never deletes them.

## Project contract

`muxtra init` creates `.muxtra/project.yaml`. Commit this file so every developer and coding agent receives the same operational workflow after cloning the repository.

Agent instruction files are opt-in. Run `muxtra install-guide` after initialization, or
use `muxtra init --install-guide` in a new setup, to add a managed block to `AGENTS.md`.
Review and commit that change like any other repository instruction.

```yaml
version: 1
project:
  name: example-app
repository:
  default_branch: main
runtime:
  install: pnpm install
  development: pnpm dev
  healthcheck: /
  port_env: PORT
  environment:
    provider: inherit
    target: development
  copy_into_workspaces: []
checks:
  - pnpm typecheck
  - pnpm test
  - pnpm build
lanes:
  design:
    agent: claude
  code:
    agent: codex
git:
  branch_prefix: agent
  agents_may_commit: true
  agents_may_push_feature_branches: true
  direct_push_to_main: false
  force_push: false
production:
  requires_approval: true
  deploy_by_merging: true
```

The project contract contains commands and policy, not credentials. Machine-local state is stored inside the repository's shared Git directory. Managed worktrees and logs live under `~/.muxtra/` by default; set `MUXTRA_HOME` to choose another location.

## Development servers

Start, inspect, and stop the configured development server for a workspace:

```bash
muxtra dev dashboard-feature
muxtra status
muxtra logs dashboard-feature
muxtra stop dashboard-feature
```

Muxtra allocates a local port, records the process and log path, and checks the configured health URL. Running `muxtra dev` from inside a registered worktree infers its workspace name.

Agents started through `muxtra launch` are explicitly instructed to use `muxtra bootstrap`, `muxtra dev`, `muxtra logs`, and `muxtra stop` rather than bypassing the managed runtime lifecycle. Codex CLI and Claude Code run with the isolated worktree as their current project. Other clients can use the portable `muxtra instructions` handoff and register their activity with `muxtra attach`.

For a Vercel-backed development environment:

```yaml
runtime:
  development: pnpm dev
  healthcheck: /
  port_env: PORT
  environment:
    provider: vercel
    target: development
providers:
  vercel:
    enabled: true
    project: example-app
    production_branch: main
```

The CLI copies only `.vercel/project.json` into the worktree, verifies the project link, and starts the configured command through `vercel env run`. Environment values are injected into the child process rather than written to an environment file.

## Commands

```text
muxtra setup
muxtra start <task> [--agent <agent>] [--lane <design|code>] [--model <model>] [--name <name>] [--base <git-ref>] [--fetch] [--image <path>] [--no-launch]
muxtra lanes
muxtra lanes set <design|code> --agent <claude|codex> [--model <model> | --clear-model]
muxtra team <task> [--design-agent <agent>] [--design-model <model>] [--code-agent <agent>] [--code-model <model>] [--base <git-ref>] [--fetch] [--image <path>]
muxtra init [--install-guide]
muxtra context [--json]
muxtra claim <paths...> [--write | --read] [--task <text>] [--agent <name>] [--ttl <minutes>] [--allow-space-paths] [--fail-on-conflict] [--json]
muxtra who [--json]
muxtra release [--agent <name>] [--all]
muxtra build [--agent <name>] [--wait <duration>] [--json]
muxtra agent-guide
muxtra install-guide [--file <name>]
muxtra doctor
muxtra bootstrap [--apply]
muxtra enter <name> --agent <agent> [--lane <design|code>] [--model <model>] [--base <git-ref>] [--fetch] [--allow-stale-base]
muxtra adopt <path> --agent <agent> [--name <name>] [--base <git-ref>]
muxtra agents [--json]
muxtra launch [name] [--agent <agent>] [--model <model>] [--prompt <task>] [--dry-run]
muxtra attach [name] [--agent <agent>] [--json]
muxtra instructions [name] [--agent <agent>] [--model <model>] [--prompt <task>]
muxtra remove <name>
muxtra dev [name] [--port <port>] [--no-wait]
muxtra logs <name> [--lines <count>]
muxtra stop <name> [--force]
muxtra status [--json] [--fetch] [--details]
muxtra finish [name] [--agent <agent>] [--fetch] [--json]
muxtra combine [names...] [--json]
muxtra combine --abort
muxtra combine-status [--json]
```

## Machine-readable protocol

Commands with `--json` write only one versioned envelope to stdout. Progress and check
output go to stderr, so agents and scripts can parse stdout directly:

```json
{
  "schemaVersion": 1,
  "command": "status",
  "generatedAt": "2026-08-14T12:00:00.000Z",
  "data": []
}
```

Consumers should verify `schemaVersion` before interpreting `data`. The package also
exports `getWorkspaceStatuses`, `resolveWorkspaceStatus`, `runProjectChecks`, and the
JSON envelope helpers for future MCP servers, dashboards, and other local adapters.

## Working in parallel

Isolation alone does not prevent agents from colliding. Two agents in separate
worktrees never see each other's files, so a change that spans a boundary — a widened
enum, a renamed symbol, a moved module — compiles for its author and breaks everyone
else, either immediately in a shared checkout or later at merge.

Claims make that visible:

```bash
muxtra claim "src/ui/**" "src/ui.test.ts" --task "chat rendering" # one argument per path
muxtra who                                          # every agent's declared paths
muxtra build                                        # checks, plus a verdict on failure
muxtra finish                                       # verify the committed branch and release
```

A claim is a lease, not a lock. It expires after inactivity, so an agent that crashes
cannot wedge the repository. Muxtra commands run by an identified agent refresh its
active claims; expired claims are never revived implicitly. Claims are stored one file
per claim in the Git common directory, which every worktree in the same local clone
shares. The registry is machine-local and does not synchronize claims between clones.
`--fail-on-conflict` rejects an overlap visible when the command runs, but it does not
turn advisory claims into an atomic cross-process lock.

`muxtra build` runs the checks from the project contract and, when one fails, reads
file names from the output and cross-references them with active write claims. Claims
are ownership signals, not proof of causation: diagnostics can name a file even when
the root cause is elsewhere, and sibling-worktree edits are not part of the current
build.

```text
✖ check failed: pnpm typecheck

Files named by the failure:
  core/suite.js (modified 7s ago)

Verdict: CLAIMED BY ANOTHER AGENT
  bob holds a write claim on core/** — started 4m ago, last seen 3s ago
    task: widen the scoring enum
    covers: core/suite.js

This is an ownership signal, not proof of who caused the failure.
Do not edit the claimed paths without coordinating with that agent.
```

Verdicts are `CLAIMED BY YOU`, `CLAIMED BY ANOTHER AGENT`, `MIXED CLAIMS`, `OUTSIDE
YOUR CLAIM`, and `UNATTRIBUTED`. Passing runs record a last-known-green commit only
when the worktree is clean; successful dirty runs do not mislabel `HEAD` as green.

Agents discover all of this through `muxtra agent-guide`, through launch instructions,
and through the opt-in block `muxtra install-guide` writes into `AGENTS.md`.

`bootstrap` is non-mutating unless `--apply` is provided. Without it, the command only reports the configured installation step.

## Safety model

- Workspaces are created outside the source repository by default.
- Existing worktrees are adopted without moving, resetting, or rewriting them.
- Workspace removal refuses to discard uncommitted changes and retains Git branches.
- The exact base commit is recorded when a workspace is created.
- Stale workspaces are reported before integration or deployment work.
- `finish` refuses dirty, stale, uncommitted, unchecked, or actively served workspaces.
- `combine` refuses unverified or changed tasks and never applies a failed composition.
- Production and force-push policy is explicit in the committed contract.
- Vercel authentication and environment retrieval remain delegated to the Vercel CLI.
- Muxtra does not collect telemetry.

Project policy is descriptive in this preview. Future GitHub and deployment adapters will enforce remote operations independently of agent behavior.

## Development

```bash
git clone https://github.com/svvayyy/Muxtra.git
cd Muxtra
pnpm install
pnpm typecheck
pnpm test
pnpm build
npm link
```

Integration tests create temporary Git repositories and real local development processes. Temporary resources are removed after each test.

## Roadmap

- Checkpoint and recovery commands for work in progress
- File-overlap warnings between active workspaces
- Agent-assisted semantic resolution for same-file integration conflicts
- Guarded branch push and pull-request creation
- Preview deployment association and verification
- Approval-gated production promotion
- Cross-machine workspace discovery

## License

[MIT](LICENSE)
