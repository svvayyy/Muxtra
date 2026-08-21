import path from "node:path";
import { configExists, loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { defaultBranch, gitBranch, gitRoot, resolveRef } from "../git.js";
import { run } from "../process.js";
import { initCommand } from "./init.js";

/**
 * Beginner-facing setup. The project contract must live in the shared commit so every
 * isolated agent receives it; this command makes that one safe, narrowly scoped commit.
 */
export async function setupCommand(cwd: string): Promise<void> {
  const root = await gitRoot(cwd);
  if (await configExists(root)) {
    console.log("Muxtra is already set up for this project.");
    const { config } = await loadConfig(root);
    if (config.checks.length === 0) {
      printMissingChecks();
      return;
    }
    console.log('Start work with: muxtra start "Describe the task" --agent codex');
    return;
  }

  try {
    await resolveRef(root, "HEAD");
  } catch {
    throw new CliError(
      "This project needs an initial Git commit before Muxtra can create isolated agent workspaces.",
    );
  }

  const primaryBranch = await defaultBranch(root);
  const currentBranch = await gitBranch(root);
  if (currentBranch !== primaryBranch) {
    throw new CliError(
      `Run Muxtra setup from the primary branch (${primaryBranch}). ` +
        `The current branch is ${currentBranch}. Switch with "git switch ${primaryBranch}", then run "muxtra setup" again.`,
    );
  }

  await initCommand(root, false, true);
  const relativeConfigPath = path.join(".muxtra", "project.yaml");
  try {
    await run("git", ["add", "--", relativeConfigPath], root);
    await run("git", ["commit", "-m", "Configure Muxtra", "--", relativeConfigPath], root);
  } catch (error) {
    await run("git", ["reset", "HEAD", "--", relativeConfigPath], root).catch(() => undefined);
    throw new CliError(
      `Muxtra created ${relativeConfigPath}, but Git could not commit it. ` +
        `Commit that file once, then run your first task. ${error instanceof Error ? error.message : ""}`,
    );
  }

  const { config } = await loadConfig(root);
  console.log('Committed .muxtra/project.yaml as "Configure Muxtra".');
  if (config.checks.length === 0) {
    printMissingChecks();
    return;
  }

  console.log("\n✓ Muxtra is ready.");
  console.log('Start your first task with: muxtra start "Describe what you want" --agent codex');
}

function printMissingChecks(): void {
  console.warn("\n⚠ Muxtra needs at least one project check before work can start.");
  console.warn(
    "Add your test, build, lint, or typecheck commands under checks: in .muxtra/project.yaml.",
  );
  console.warn("Commit that change, then run muxtra setup again to confirm the project is ready.");
}
