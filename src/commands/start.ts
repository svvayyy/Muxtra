import { loadConfig } from "../config.js";
import { access } from "node:fs/promises";
import { normalizeStableAgent } from "../agents.js";
import { slugify } from "../format.js";
import { hasRef, gitStatus } from "../git.js";
import { CliError } from "../errors.js";
import { readState } from "../state.js";
import path from "node:path";
import { enterCommand } from "./enter.js";
import { launchCommand } from "./launch.js";
import { normalizeTaskLane, resolveLaneSelection, type TaskLane } from "../lanes.js";
import type { WorkspaceRecord } from "../state.js";

export interface StartOptions {
  agent?: string;
  lane?: string;
  model?: string;
  name?: string;
  base?: string;
  fetch?: boolean;
  launch: boolean;
  images?: string[];
  teamId?: string;
  peerWorkspaces?: string[];
  /** Internal: a multi-task operation already checked the root before its first task. */
  skipCleanCheck?: boolean;
}

/** Create the isolated workspace and immediately hand the user's task to an agent. */
export async function startCommand(
  cwd: string,
  prompt: string,
  options: StartOptions,
): Promise<WorkspaceRecord> {
  const { root, config } = await loadConfig(cwd);
  if (config.checks.length === 0) {
    throw new CliError(
      "No project checks are configured. Add at least one test, build, lint, or typecheck command " +
        'under "checks:" in .muxtra/project.yaml and commit it before starting a task.',
    );
  }
  const lane = options.lane ? normalizeTaskLane(options.lane) : undefined;
  const state = await readState(root);
  const selection = lane
    ? resolveLaneSelection(
        config,
        lane,
        { agent: options.agent, model: options.model },
        state.laneDefaults?.[lane],
      )
    : options.agent
      ? {
          agent: normalizeStableAgent(options.agent),
          ...(options.model ? { model: options.model } : {}),
        }
      : undefined;
  if (!selection) {
    throw new CliError("Choose --agent <agent> or a configured --lane <design|code>.");
  }
  const { agent, model } = selection;
  const attachments = (options.images ?? []).map((image) => path.resolve(cwd, image));
  for (const attachment of attachments) {
    try {
      await access(attachment);
    } catch {
      throw new CliError(`Attached image does not exist or cannot be read: ${attachment}`);
    }
  }
  if (!options.skipCleanCheck && (await gitStatus(root)).length > 0) {
    throw new CliError(
      "This project has local changes that new agents cannot see yet. Save or commit them " +
        "before starting the task; Muxtra will not commit application code without permission.",
    );
  }
  const name = options.name
    ? slugify(options.name)
    : await availableTaskName(root, prompt, agent, config.git.branch_prefix, lane);
  const workspace = await enterCommand(root, name, {
    agent,
    task: prompt,
    displayName: options.name,
    base: options.base,
    fetch: options.fetch,
    quiet: true,
    attachments,
    lane,
    model,
    teamId: options.teamId,
    peerWorkspaces: options.peerWorkspaces,
  });

  console.log("✓ Task workspace created");
  console.log(`Task: ${workspace.task}`);
  console.log(`Agent: ${workspace.agent}`);
  if (workspace.lane) console.log(`Lane: ${workspace.lane}`);
  if (workspace.model) console.log(`Model: ${workspace.model}`);
  console.log(`Workspace: ${workspace.name}`);

  if (!options.launch) {
    console.log(`\nReady to launch later with: muxtra launch ${workspace.name}`);
    return workspace;
  }

  console.log("");
  await launchCommand(root, workspace.name, { prompt, model });
  return workspace;
}

async function availableTaskName(
  root: string,
  prompt: string,
  agent: string,
  branchPrefix: string,
  lane?: TaskLane,
): Promise<string> {
  const promptBase = slugify(prompt)
    .split("-")
    .slice(0, lane ? 5 : 6)
    .join("-");
  const base = lane ? `${promptBase}-${lane}` : promptBase;
  const normalizedAgent = slugify(agent);
  const state = await readState(root);

  for (let suffix = 1; suffix < 1_000; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    const branch = `${branchPrefix}/${normalizedAgent}/${candidate}`;
    const registered = state.workspaces.some((workspace) => workspace.name === candidate);
    if (!registered && !(await hasRef(root, `refs/heads/${branch}`))) return candidate;
  }

  throw new Error(`Could not generate a unique workspace name for: ${prompt}`);
}
