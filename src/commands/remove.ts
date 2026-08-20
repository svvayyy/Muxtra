import { access } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { gitStatus, removeWorktree } from "../git.js";
import { isProcessAlive } from "../runtime.js";
import { readState, removeWorkspace } from "../state.js";

export async function removeCommand(cwd: string, name: string): Promise<void> {
  const { root } = await loadConfig(cwd);
  const state = await readState(root);
  const workspace = state.workspaces.find((candidate) => candidate.name === name);
  if (!workspace) throw new CliError(`Unknown workspace: ${name}`);

  if (
    workspace.agentActivity?.status === "running" &&
    workspace.agentActivity.pid !== undefined &&
    isProcessAlive(workspace.agentActivity.pid)
  ) {
    throw new CliError(
      `Workspace ${name} still has a running agent. Stop that agent before removing the task.`,
    );
  }

  if (workspace.development?.status === "running" && isProcessAlive(workspace.development.pid)) {
    throw new CliError(
      `Workspace ${name} still has a running development process. ` +
        `Run "muxtra stop ${name}" first.`,
    );
  }

  if (workspace.managed !== true) {
    await removeWorkspace(root, workspace.id);
    console.log(`Unregistered adopted workspace: ${name}`);
    console.log(`Worktree retained: ${workspace.worktree}`);
    console.log(`Branch retained: ${workspace.branch}`);
    return;
  }

  try {
    await access(workspace.worktree);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await removeWorkspace(root, workspace.id);
    console.log(`Removed missing workspace from local state: ${name}`);
    console.log(`Branch retained: ${workspace.branch}`);
    return;
  }

  const status = await gitStatus(workspace.worktree);
  if (status) {
    throw new CliError(
      `Workspace ${name} has uncommitted changes and was not removed. ` +
        `Commit, stash, or discard them explicitly in ${workspace.worktree}.`,
    );
  }

  await removeWorktree(root, workspace.worktree);
  await removeWorkspace(root, workspace.id);
  console.log(`Removed workspace: ${name}`);
  console.log(`Worktree removed: ${workspace.worktree}`);
  console.log(`Branch retained: ${workspace.branch}`);
}
