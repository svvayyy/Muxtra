import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeStableAgent, type StableAgent } from "../agents.js";
import { loadConfig, type ProjectConfig } from "../config.js";
import { CliError } from "../errors.js";
import { gitRoot } from "../git.js";
import { commandExists, runInteractiveCommand } from "../process.js";
import { isProcessAlive } from "../runtime.js";
import { pathsReferToSameLocation } from "../paths.js";
import {
  readState,
  recordAgentExit,
  recordManagedAgentLaunch,
  type WorkspaceRecord,
} from "../state.js";

export interface LaunchOptions {
  agent?: string;
  model?: string;
  prompt?: string;
  dryRun?: boolean;
}

export interface AgentLaunchSpec {
  agent: StableAgent;
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}

export async function launchCommand(
  cwd: string,
  requestedName: string | undefined,
  options: LaunchOptions,
): Promise<void> {
  const resolved = await resolveWorkspace(cwd, requestedName);
  const agent = normalizeStableAgent(options.agent ?? resolved.workspace.agent);
  const model = options.model?.trim() || resolved.workspace.model;
  const instructions = buildAgentInstructions(
    resolved.config,
    resolved.workspace,
    agent,
    options.prompt ?? resolved.workspace.task,
    model,
  );
  const sessionId = randomUUID();
  const specification = buildLaunchSpec(
    agent,
    resolved.workspace,
    instructions,
    process.env,
    sessionId,
    model,
  );

  if (options.dryRun) {
    printLaunchPreview(resolved.workspace, specification, instructions);
    return;
  }

  if (!(await commandExists(specification.command))) {
    throw new CliError(
      `Agent executable is not installed or not on PATH: ${specification.command}. ` +
        `Run "muxtra instructions ${resolved.workspace.name}" to hand the context to another client.`,
    );
  }

  if (
    resolved.workspace.agentActivity?.status === "running" &&
    resolved.workspace.agentActivity.pid !== undefined &&
    isProcessAlive(resolved.workspace.agentActivity.pid)
  ) {
    throw new CliError(
      `Agent ${resolved.workspace.agentActivity.agent} is already running in workspace ${resolved.workspace.name}.`,
    );
  }

  console.log(`Launching ${agent} in workspace ${resolved.workspace.name}`);
  console.log(`Worktree: ${resolved.workspace.worktree}`);
  console.log("Muxtra will provide the repository workflow as the agent's initial instructions.\n");
  await runInteractiveCommand(
    specification.command,
    specification.args,
    resolved.workspace.worktree,
    specification.environment,
    {
      onSpawn: async (pid) => {
        const now = new Date().toISOString();
        await recordManagedAgentLaunch(resolved.root, resolved.workspace.id, {
          sessionId,
          agent,
          source: "managed",
          status: "running",
          phase: "working",
          pid,
          startedAt: now,
          lastSeenAt: now,
        });
      },
      onExit: async (code, signal) => {
        await recordAgentExit(resolved.root, resolved.workspace.id, sessionId, { code, signal });
      },
    },
  );
}

export async function instructionsCommand(
  cwd: string,
  requestedName: string | undefined,
  options: Pick<LaunchOptions, "agent" | "prompt" | "model">,
): Promise<void> {
  const resolved = await resolveWorkspace(cwd, requestedName);
  const agent = options.agent?.trim() ? options.agent.trim() : resolved.workspace.agent;
  console.log(
    buildAgentInstructions(
      resolved.config,
      resolved.workspace,
      agent,
      options.prompt,
      options.model?.trim() || resolved.workspace.model,
    ),
  );
}

export function buildLaunchSpec(
  agent: StableAgent,
  workspace: WorkspaceRecord,
  instructions: string,
  baseEnvironment: NodeJS.ProcessEnv,
  sessionId?: string,
  model?: string,
): AgentLaunchSpec {
  const environment: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    MUXTRA_WORKSPACE: workspace.name,
    MUXTRA_WORKTREE: workspace.worktree,
    MUXTRA_AGENT: agent,
    ...(model ? { MUXTRA_MODEL: model } : {}),
    ...(workspace.lane ? { MUXTRA_LANE: workspace.lane } : {}),
    ...(sessionId ? { MUXTRA_SESSION_ID: sessionId } : {}),
    // Keep the preview-era variables for existing agent scripts during the rename.
    PARALLEL_AGENT_WORKSPACE: workspace.name,
    PARALLEL_AGENT_WORKTREE: workspace.worktree,
    PARALLEL_AGENT_AGENT: agent,
  };
  const images = workspace.attachments ?? [];
  const imageArguments = images.length > 0 ? ["--image", ...images] : [];
  const attachmentDirectories = [...new Set(images.map((image) => path.dirname(image)))];
  const claudeDirectoryArguments =
    attachmentDirectories.length > 0 ? ["--add-dir", ...attachmentDirectories] : [];

  switch (agent) {
    case "codex":
      return {
        agent,
        command: "codex",
        args: [
          ...imageArguments,
          ...(model ? ["--model", model] : []),
          "--cd",
          workspace.worktree,
          instructions,
        ],
        environment,
      };
    case "claude":
      return {
        agent,
        command: "claude",
        args: [
          ...claudeDirectoryArguments,
          ...(model ? ["--model", model] : []),
          "--settings",
          JSON.stringify(buildClaudeLifecycleSettings()),
          instructions,
        ],
        environment,
      };
  }
}

export function buildClaudeLifecycleSettings(): object {
  const commandHook = (state: "working" | "waiting" | "needs_input") => ({
    hooks: [{ type: "command", command: `muxtra agent-status --state ${state}`, timeout: 5 }],
  });
  return {
    hooks: {
      SessionStart: [commandHook("working")],
      UserPromptSubmit: [commandHook("working")],
      PreToolUse: [commandHook("working")],
      Notification: [
        {
          matcher: "permission_prompt|idle_prompt|elicitation_dialog",
          ...commandHook("needs_input"),
        },
      ],
      Stop: [commandHook("waiting")],
      StopFailure: [commandHook("needs_input")],
    },
  };
}

export function buildAgentInstructions(
  config: ProjectConfig,
  workspace: WorkspaceRecord,
  agent: string,
  prompt?: string,
  model?: string,
): string {
  const install = config.runtime.install ?? "not configured";
  const development = config.runtime.development ?? "not configured";
  const checks = config.checks.length > 0 ? config.checks.join(", ") : "none configured";
  const task = prompt?.trim();
  const attachments = workspace.attachments ?? [];
  const laneContext = buildLaneContext(workspace);
  let activityInstruction: string;
  try {
    const stableAgent = normalizeStableAgent(agent);
    activityInstruction = `Start by running "muxtra attach ${workspace.name} --agent ${stableAgent}". This lets Muxtra show that you are active without reading this conversation.`;
  } catch {
    activityInstruction =
      "This client is using a portable handoff. Muxtra will observe workspace changes, but live agent-session status is currently available only for Claude Code and Codex CLI.";
  }

  return `Muxtra workspace instructions

You are the ${agent} agent assigned to the isolated workspace "${workspace.name}" for project "${config.project.name}".
${workspace.lane ? `Lane: ${workspace.lane}` : ""}${model ? `\nModel: ${model}` : ""}

Workspace: ${workspace.worktree}
Branch: ${workspace.branch}
Recorded base: ${workspace.baseRef} (${workspace.baseSha})
Install command in project contract: ${install}
Development command in project contract: ${development}
Required checks: ${checks}

Operating rules:
1. ${activityInstruction}
2. Work only in the workspace path above. Do not edit another checkout of this repository. Run "muxtra context" before making changes so you have the current repository workflow and safety policy.
3. Other agents may be working in this repository at the same time. Run "muxtra who" to see them, then publish your own intent before you edit: muxtra claim --write "<paths>" --task "<one line>". Claims never block you; they let build diagnostics surface path ownership.
4. Run checks with "muxtra build" rather than invoking the check commands directly. Its verdicts are ownership signals, not proof of causation. Never edit files inside another agent's write claim without coordinating. Run "muxtra agent-guide" for the full protocol.
5. When dependencies are missing, run "muxtra bootstrap" first and then "muxtra bootstrap --apply" if installation is needed. Do not bypass the configured bootstrap command with a package-manager install.
6. Start the project with "muxtra dev". Do not run the development command directly; Muxtra must allocate the port, inject the configured environment, and track the process.
7. Inspect the server with "muxtra logs ${workspace.name}" and stop it with "muxtra stop ${workspace.name}".
8. Repository instructions such as AGENTS.md or CLAUDE.md still apply to implementation work. The committed .muxtra/project.yaml contract is authoritative for workspace, runtime, Git, and deployment operations.
9. Direct pushes to ${config.repository.default_branch} are ${config.git.direct_push_to_main ? "allowed by project policy" : "forbidden"}. Force pushes are ${config.git.force_push ? "allowed by project policy" : "forbidden"}.
10. ${config.production.requires_approval ? "Do not deploy or promote to production without explicit user approval." : "Follow the project contract before any production operation."}
11. When your changes are committed, run "muxtra finish ${workspace.name}". It reruns the project checks, verifies freshness and cleanliness, and releases your claim only when the branch is ready for integration.
${laneContext}

${task ? `User task:\n${task}` : "Load the project context, then ask the user what they want to work on."}${
    attachments.length > 0
      ? `\n\nAttached images:\n${attachments.map((attachment) => `- ${attachment}`).join("\n")}\nInspect these images as part of the user's task.`
      : ""
  }`;
}

function buildLaneContext(workspace: WorkspaceRecord): string {
  if (workspace.lane === "design") {
    return `
Lane responsibilities:
- Own the UI, frontend behavior, visual hierarchy, responsive states, accessibility, and design-system consistency.
- Inspect the existing product before editing. Preserve working backend contracts unless the task explicitly requires a coordinated change.
- Prefer production UI code over static mockups. Verify the visible result at desktop and narrow widths.
- Coordinate through claims before touching shared schemas or backend files.${formatPeers(workspace)}`;
  }
  if (workspace.lane === "code") {
    return `
Lane responsibilities:
- Own backend logic, application state, data flow, integrations, architecture, reliability, and tests.
- Expose clean interfaces for the design lane and avoid restyling frontend surfaces unless required for correctness.
- Preserve existing product behavior, add proportionate tests, and document any interface the design lane must consume.
- Coordinate through claims before touching shared UI contracts or frontend files.${formatPeers(workspace)}`;
  }
  return "";
}

function formatPeers(workspace: WorkspaceRecord): string {
  return workspace.peerWorkspaces?.length
    ? `\n- Paired workspace${workspace.peerWorkspaces.length === 1 ? "" : "s"}: ${workspace.peerWorkspaces.join(", ")}. Use "muxtra status" and "muxtra who" to follow its progress without entering its worktree.`
    : "";
}

async function resolveWorkspace(cwd: string, requestedName: string | undefined) {
  const { root, config } = await loadConfig(cwd);
  const state = await readState(root);
  let currentRoot: string | undefined;
  if (!requestedName) {
    try {
      currentRoot = await gitRoot(cwd);
    } catch {
      currentRoot = undefined;
    }
  }
  let workspace = requestedName
    ? state.workspaces.find((candidate) => candidate.name === requestedName)
    : undefined;
  if (!workspace && currentRoot) {
    for (const candidate of state.workspaces) {
      if (await pathsReferToSameLocation(candidate.worktree, currentRoot)) {
        workspace = candidate;
        break;
      }
    }
  }
  if (!workspace) {
    throw new CliError(
      requestedName
        ? `Unknown workspace: ${requestedName}`
        : "Could not infer a workspace from this directory. Pass a workspace name.",
    );
  }
  try {
    await access(workspace.worktree);
  } catch {
    throw new CliError(`Workspace worktree is missing: ${workspace.worktree}`);
  }
  return { root, config, workspace };
}

function printLaunchPreview(
  workspace: WorkspaceRecord,
  specification: AgentLaunchSpec,
  instructions: string,
): void {
  console.log(`Agent: ${specification.agent}`);
  console.log(`Workspace: ${workspace.name}`);
  console.log(`Worktree: ${workspace.worktree}`);
  console.log(`Executable: ${specification.command}`);
  console.log("\nInitial instructions:\n");
  console.log(instructions);
}
