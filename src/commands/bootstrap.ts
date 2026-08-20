import { loadConfig } from "../config.js";
import { runShellCommand } from "../process.js";
import { doctorCommand } from "./doctor.js";

export async function bootstrapCommand(cwd: string, apply: boolean): Promise<void> {
  const { root, config } = await loadConfig(cwd);
  await doctorCommand(root);

  if (!config.runtime.install) {
    console.log("\nNo runtime install command is configured.");
    return;
  }

  if (!apply) {
    console.log(`\nWould run: ${config.runtime.install}`);
    console.log("Re-run with --apply to execute repository-configured bootstrap commands.");
    return;
  }

  console.log(`\nRunning: ${config.runtime.install}`);
  await runShellCommand(config.runtime.install, root);
}
