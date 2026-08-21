#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command, Help } from "commander";
import { heartbeatIdentity } from "./claims.js";
import { agentsCommand } from "./commands/agents.js";
import { agentStatusCommand } from "./commands/agent-status.js";
import { attachCommand } from "./commands/attach.js";
import { bootstrapCommand } from "./commands/bootstrap.js";
import { buildCommand } from "./commands/build.js";
import { claimCommand, releaseCommand, whoCommand } from "./commands/claim.js";
import { combineCommand, combineStatusCommand } from "./commands/combine.js";
import { agentGuideCommand, installGuideCommand } from "./commands/guide.js";
import { adoptCommand } from "./commands/adopt.js";
import { contextCommand } from "./commands/context.js";
import { doctorCommand } from "./commands/doctor.js";
import { devCommand } from "./commands/dev.js";
import { enterCommand } from "./commands/enter.js";
import { finishCommand } from "./commands/finish.js";
import { initCommand } from "./commands/init.js";
import { instructionsCommand, launchCommand } from "./commands/launch.js";
import { logsCommand } from "./commands/logs.js";
import { lanesCommand, setLaneCommand } from "./commands/lanes.js";
import { removeCommand } from "./commands/remove.js";
import { statusCommand } from "./commands/status.js";
import { stopCommand } from "./commands/stop.js";
import { setupCommand } from "./commands/setup.js";
import { startCommand } from "./commands/start.js";
import { teamCommand } from "./commands/team.js";
import { updateCommand } from "./commands/update.js";
import { CliError } from "./errors.js";
import { gitRoot } from "./git.js";
import { resolveIdentity } from "./identity.js";
import { touchWorkspaceAgent } from "./state.js";
import { normalizeTaskLane } from "./lanes.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

const program = new Command();
program
  .name("muxtra")
  .description("Run coding agents from different providers safely in the same project")
  .version(packageJson.version);

program
  .command("agents")
  .description("Show the coding-agent CLIs Muxtra can launch on this computer")
  .option("--json", "print a versioned machine-readable report")
  .action((options: { json?: boolean }) => agentsCommand(Boolean(options.json)));

program
  .command("combine")
  .argument("[names...]", "finished task names; defaults to every verified, uncombined task")
  .description("Combine verified agent work and apply it only after all checks pass")
  .option("--abort", "discard an unfinished temporary combination; task branches are retained")
  .option("--json", "print a versioned machine-readable report")
  .action((names: string[], options: { abort?: boolean; json?: boolean }) =>
    combineCommand(process.cwd(), names, options),
  );

program
  .command("combine-status")
  .description("Show the current combined or temporary result")
  .option("--json", "print a versioned machine-readable report")
  .action((options: { json?: boolean }) =>
    combineStatusCommand(process.cwd(), Boolean(options.json)),
  );

program
  .command("setup")
  .description("Prepare this project for Muxtra")
  .action(() => setupCommand(process.cwd()));

program
  .command("start")
  .argument("<title>", "short title used to identify and track the task")
  .description("Create an isolated workspace and open an agent session")
  .option("--agent <agent>", "agent provider, for example codex or claude")
  .option("--lane <lane>", "task lane: design or code")
  .option("--model <model>", "exact provider model for this task")
  .option("--name <name>", "optional workspace name; generated from the title by default")
  .option("--prompt <prompt>", "explicit initial user prompt for the agent")
  .option("--base <ref>", "advanced: explicit Git ref to branch from")
  .option("--fetch", "fetch origin before resolving the base")
  .option(
    "--image <path>",
    "attach a local image (repeat for more than one)",
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .option("--no-launch", "create the task without opening the agent yet")
  .action(
    (
      title: string,
      options: {
        agent?: string;
        lane?: string;
        model?: string;
        name?: string;
        prompt?: string;
        base?: string;
        fetch?: boolean;
        image?: string[];
        launch: boolean;
      },
    ) =>
      startCommand(process.cwd(), title, { ...options, images: options.image }).then(
        () => undefined,
      ),
  );

const lanes = program
  .command("lanes")
  .description("Show the provider and model used for design and code work")
  .option("--json", "print machine-readable lane defaults")
  .action((options: { json?: boolean }) => lanesCommand(process.cwd(), Boolean(options.json)));

lanes
  .command("set")
  .argument("<lane>", "design or code")
  .description("Set the default provider and model for one task lane")
  .requiredOption("--agent <agent>", "claude or codex")
  .option("--model <model>", "exact provider model")
  .option("--clear-model", "use the provider's default model")
  .action((lane: string, options: { agent: string; model?: string; clearModel?: boolean }) =>
    setLaneCommand(process.cwd(), lane, options),
  );

program
  .command("team")
  .argument("<title>", "short title used to identify the coordinated work")
  .description("Create coordinated design and code tasks with separate models")
  .option("--design-agent <agent>", "override the configured design provider")
  .option("--design-model <model>", "override the configured design model")
  .option("--code-agent <agent>", "override the configured code provider")
  .option("--code-model <model>", "override the configured code model")
  .option("--base <ref>", "advanced: explicit Git ref to branch from")
  .option("--fetch", "fetch origin before resolving the base")
  .option(
    "--image <path>",
    "attach a local image to both tasks (repeat for more than one)",
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .action(
    (
      title: string,
      options: {
        designAgent?: string;
        designModel?: string;
        codeAgent?: string;
        codeModel?: string;
        base?: string;
        fetch?: boolean;
        image?: string[];
      },
    ) =>
      teamCommand(process.cwd(), title, { ...options, images: options.image }).then(
        () => undefined,
      ),
  );

program
  .command("update")
  .description("Update Muxtra to the newest npm beta release")
  .action(() => updateCommand(process.cwd()));

program
  .command("init")
  .description("Create a repository-owned Muxtra project contract")
  .option("--install-guide", "also add a managed Muxtra block to AGENTS.md")
  .action((options: { installGuide?: boolean }) =>
    initCommand(process.cwd(), Boolean(options.installGuide)),
  );

program
  .command("context")
  .description("Print the project workflow and current agent context")
  .option("--json", "print machine-readable JSON")
  .action((options: { json?: boolean }) => contextCommand(process.cwd(), Boolean(options.json)));

program
  .command("claim")
  .argument("<paths...>", "paths or globs you are about to edit")
  .description("Publish which paths you are working on so other agents can see them")
  .option("--write", "declare write intent (the default)")
  .option("--read", "declare a read-only interest that never conflicts with other readers")
  .option("--task <text>", "one line describing what you are doing")
  .option("--agent <name>", "identify the claiming agent")
  .option("--ttl <minutes>", "expire the claim after this much inactivity")
  .option("--allow-space-paths", "allow intentional claim paths containing whitespace")
  .option("--fail-on-conflict", "exit non-zero when another agent already claimed these paths")
  .option("--json", "print machine-readable JSON")
  .action(
    (
      paths: string[],
      options: {
        write?: boolean;
        read?: boolean;
        task?: string;
        agent?: string;
        ttl?: string;
        allowSpacePaths?: boolean;
        json?: boolean;
        failOnConflict?: boolean;
      },
    ) => claimCommand(process.cwd(), paths, options),
  );

program
  .command("release")
  .description("Drop your claim when you finish")
  .option("--agent <name>", "identify the releasing agent")
  .option("--all", "clear every claim in the repository, including expired ones")
  .action((options: { agent?: string; all?: boolean }) => releaseCommand(process.cwd(), options));

program
  .command("who")
  .description("Show every agent's declared paths and how recently each was active")
  .option("--json", "print machine-readable JSON")
  .action((options: { json?: boolean }) => whoCommand(process.cwd(), Boolean(options.json)));

program
  .command("build")
  .description("Run configured checks and match failing paths to active write claims")
  .option("--agent <name>", "identify the building agent")
  .option("--wait <duration>", "retry when failing paths intersect another write claim")
  .option("--json", "print machine-readable JSON")
  .action((options: { agent?: string; wait?: string; json?: boolean }) =>
    buildCommand(process.cwd(), options),
  );

program
  .command("agent-guide")
  .description("Print the protocol agents should follow when sharing this repository")
  .action(() => agentGuideCommand(process.cwd()));

program
  .command("install-guide")
  .description("Write the Muxtra protocol into the file agents read at startup")
  .option("--file <name>", "target file", "AGENTS.md")
  .action((options: { file: string }) => installGuideCommand(process.cwd(), options.file));

program
  .command("doctor")
  .description("Check whether this computer can operate the project safely")
  .action(() => doctorCommand(process.cwd()));

program
  .command("bootstrap")
  .description("Check and optionally prepare this computer for the project")
  .option("--apply", "run repository-configured installation commands")
  .action((options: { apply?: boolean }) =>
    bootstrapCommand(process.cwd(), Boolean(options.apply)),
  );

program
  .command("dev")
  .argument("[name]", "workspace name; inferred inside a registered workspace")
  .description("Start the configured development server for a workspace")
  .option("--port <port>", "use a specific local port")
  .option("--no-wait", "return without waiting for the health URL")
  .action((name: string | undefined, options: { port?: string; wait: boolean }) =>
    devCommand(process.cwd(), name, options),
  );

program
  .command("launch")
  .argument("[name]", "workspace name; inferred inside a registered workspace")
  .description("Launch a coding agent with the workspace's operational context")
  .option("--agent <agent>", "override the workspace's recorded agent launcher")
  .option("--model <model>", "override the workspace's recorded model")
  .option("--prompt <prompt>", "include an initial user task")
  .option("--dry-run", "print the launch context without starting the agent")
  .action(
    (
      name: string | undefined,
      options: { agent?: string; model?: string; prompt?: string; dryRun?: boolean },
    ) => launchCommand(process.cwd(), name, options),
  );

program
  .command("attach")
  .argument("[name]", "workspace name; inferred inside a registered workspace")
  .description("Tell Muxtra a Claude Code or Codex CLI session is using this workspace")
  .option("--agent <agent>", "agent CLI; inferred from the workspace by default")
  .option("--json", "print a versioned machine-readable report")
  .action((name: string | undefined, options: { agent?: string; json?: boolean }) =>
    attachCommand(process.cwd(), name, options),
  );

program
  .command("agent-status", { hidden: true })
  .requiredOption("--state <state>")
  .action((options: { state: string }) => agentStatusCommand(process.cwd(), options.state));

program
  .command("instructions")
  .argument("[name]", "workspace name; inferred inside a registered workspace")
  .description("Print portable workspace instructions for any coding agent")
  .option("--agent <agent>", "name the receiving agent in the instructions")
  .option("--model <model>", "name the receiving model in the instructions")
  .option("--prompt <prompt>", "include an initial user task")
  .action(
    (name: string | undefined, options: { agent?: string; model?: string; prompt?: string }) =>
      instructionsCommand(process.cwd(), name, options),
  );

program
  .command("stop")
  .argument("<name>", "workspace name")
  .description("Stop a workspace's recorded development process")
  .option("--force", "use SIGKILL rather than SIGTERM")
  .action((name: string, options: { force?: boolean }) =>
    stopCommand(process.cwd(), name, Boolean(options.force)),
  );

program
  .command("logs")
  .argument("<name>", "workspace name")
  .description("Print the end of a workspace's development log")
  .option("--lines <count>", "number of lines to print", "50")
  .action((name: string, options: { lines: string }) =>
    logsCommand(process.cwd(), name, options.lines),
  );

program
  .command("adopt")
  .argument("<path>", "path to an existing worktree in this repository")
  .description("Register an existing Git worktree without modifying it")
  .requiredOption("--agent <agent>", "agent currently responsible for the worktree")
  .option("--name <name>", "workspace name; defaults to the final branch component")
  .option("--base <ref>", "base ref used for freshness comparison")
  .action((worktreePath: string, options: { agent: string; name?: string; base?: string }) =>
    adoptCommand(process.cwd(), worktreePath, options),
  );

program
  .command("remove")
  .argument("<name>", "workspace name")
  .description("Remove a managed worktree or unregister an adopted workspace")
  .action((name: string) => removeCommand(process.cwd(), name));

program
  .command("enter")
  .argument("<name>", "workspace/task name")
  .description("Create an isolated Git worktree and branch for an agent")
  .requiredOption("--agent <agent>", "agent name, for example codex or claude")
  .option("--lane <lane>", "task lane: design or code")
  .option("--model <model>", "exact provider model for this workspace")
  .option("--base <ref>", "explicit Git ref to branch from")
  .option("--fetch", "fetch origin before resolving the base")
  .option(
    "--allow-stale-base",
    "allow an intentional stacked workspace whose base is behind the canonical branch",
  )
  .action(
    (
      name: string,
      options: {
        agent: string;
        lane?: string;
        model?: string;
        base?: string;
        fetch?: boolean;
        allowStaleBase?: boolean;
      },
    ) =>
      enterCommand(process.cwd(), name, {
        ...options,
        lane: options.lane ? normalizeTaskLane(options.lane) : undefined,
      }).then(() => undefined),
  );

program
  .command("status")
  .description("Show active tasks in human-friendly language")
  .option("--json", "print machine-readable JSON")
  .option("--fetch", "fetch origin before calculating freshness")
  .option("--details", "show branches, commits, and workspace diagnostics")
  .action((options: { json?: boolean; fetch?: boolean; details?: boolean }) =>
    statusCommand(
      process.cwd(),
      Boolean(options.json),
      Boolean(options.fetch),
      Boolean(options.details),
    ),
  );

program
  .command("finish")
  .argument("[name]", "workspace name; inferred inside a registered workspace")
  .description("Verify that a committed workspace is ready for integration")
  .option("--agent <agent>", "identify the finishing agent")
  .option("--fetch", "fetch origin before checking freshness")
  .option("--json", "print a versioned machine-readable report")
  .action(
    (name: string | undefined, options: { agent?: string; fetch?: boolean; json?: boolean }) =>
      finishCommand(process.cwd(), name, options),
  );

program.hook("preAction", async (_command, actionCommand) => {
  const command = actionCommand.name();
  if (["agent-status", "agents", "init", "release", "update"].includes(command)) return;

  const root = await gitRoot(process.cwd());
  const agent = actionCommand.opts<{ agent?: string }>().agent;
  const identity = await resolveIdentity(root, agent);
  if (identity.source !== "unknown") {
    await heartbeatIdentity(root, identity.agent, identity.workspace);
    const activityCommands = new Set([
      "bootstrap",
      "build",
      "claim",
      "context",
      "dev",
      "finish",
      "logs",
      "stop",
      "who",
    ]);
    if (identity.workspace && activityCommands.has(command)) {
      await touchWorkspaceAgent(root, identity.workspace, identity.agent);
    }
  }
});

const primaryHelpOrder = ["setup", "agents", "start", "status", "finish", "combine"];
const defaultHelp = new Help();
program.configureHelp({
  visibleCommands(command) {
    return [...defaultHelp.visibleCommands(command)].sort((left, right) => {
      const leftIndex = primaryHelpOrder.indexOf(left.name());
      const rightIndex = primaryHelpOrder.indexOf(right.name());
      if (leftIndex === -1 && rightIndex === -1) return 0;
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });
  },
});

program.parseAsync().catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(`muxtra: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(error);
  process.exit(1);
});
