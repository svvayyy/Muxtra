import { CliError } from "../errors.js";
import { commandExists, runInteractiveCommand } from "../process.js";

const UPDATE_TARGET = "muxtra@beta";

export async function updateCommand(cwd: string): Promise<void> {
  if (!(await commandExists("npm"))) {
    throw new CliError(
      "npm is required to update Muxtra. Install Node.js and npm, then run muxtra update again.",
    );
  }

  console.log(`Updating Muxtra from the npm beta channel (${UPDATE_TARGET})...\n`);
  await runInteractiveCommand("npm", ["install", "--global", UPDATE_TARGET], cwd);
  console.log("\n✓ Muxtra update complete");
  console.log("Run muxtra --version to confirm the installed version.");
}
