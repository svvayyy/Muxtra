import { buildAgentGuide, installGuidePointer } from "../agentGuide.js";
import { loadConfig } from "../config.js";

export async function agentGuideCommand(cwd: string): Promise<void> {
  const { config } = await loadConfig(cwd);
  console.log(buildAgentGuide(config));
}

export async function installGuideCommand(cwd: string, fileName: string): Promise<void> {
  const { root, config } = await loadConfig(cwd);
  const outcome = await installGuidePointer(root, fileName, config);

  switch (outcome) {
    case "created":
      console.log(`Created ${fileName} with the Muxtra protocol.`);
      break;
    case "updated":
      console.log(`Updated the muxtra section of ${fileName}.`);
      break;
    default:
      console.log(`${fileName} is already up to date.`);
  }

  console.log("Commit this file so every agent reads it at session start.");
}
