import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isProcessAlive, stopProcess } from "../runtime.js";
import { readState, updateWorkspace } from "../state.js";

export async function stopCommand(cwd: string, name: string, force: boolean): Promise<void> {
  const { root } = await loadConfig(cwd);
  const state = await readState(root);
  const workspace = state.workspaces.find((candidate) => candidate.name === name);
  if (!workspace) throw new CliError(`Unknown workspace: ${name}`);
  if (!workspace.development) {
    throw new CliError(`Workspace ${name} has no recorded development process.`);
  }

  const wasAlive = isProcessAlive(workspace.development.pid);
  const stopped = await stopProcess(workspace.development.pid, force);
  if (!stopped) {
    throw new CliError(
      `PID ${workspace.development.pid} did not stop after SIGTERM. Re-run with --force if appropriate.`,
    );
  }

  await updateWorkspace(root, workspace.id, (current) => ({
    ...current,
    development: current.development
      ? { ...current.development, status: "stopped", stoppedAt: new Date().toISOString() }
      : undefined,
  }));
  console.log(
    wasAlive
      ? `Stopped development server for ${name}.`
      : `Development server for ${name} had already exited; state updated.`,
  );
}
