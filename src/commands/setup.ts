import path from "node:path";
import { configExists } from "../config.js";
import { CliError } from "../errors.js";
import { gitRoot, resolveRef } from "../git.js";
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

  console.log("\n✓ Muxtra is ready.");
  console.log('Start your first task with: muxtra start "Describe what you want" --agent codex');
}
