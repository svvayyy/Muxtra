import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { readState } from "../state.js";

export async function logsCommand(
  cwd: string,
  name: string,
  requestedLines: string,
): Promise<void> {
  const { root } = await loadConfig(cwd);
  const state = await readState(root);
  const workspace = state.workspaces.find((candidate) => candidate.name === name);
  if (!workspace) throw new CliError(`Unknown workspace: ${name}`);
  if (!workspace.development) {
    throw new CliError(`Workspace ${name} has no recorded development logs.`);
  }
  const lineCount = Number(requestedLines);
  if (!Number.isInteger(lineCount) || lineCount < 1 || lineCount > 10_000) {
    throw new CliError(`Invalid line count: ${requestedLines}`);
  }
  const content = await readFile(workspace.development.logPath, "utf8");
  console.log(content.split(/\r?\n/).slice(-lineCount).join("\n"));
}
