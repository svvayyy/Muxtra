import { discoverAgentInstallations } from "../agents.js";
import { table } from "../format.js";
import { printJson } from "../protocol.js";

export async function agentsCommand(asJson: boolean): Promise<void> {
  const agents = await discoverAgentInstallations();

  if (asJson) {
    printJson("agents", agents);
    return;
  }

  console.log(
    table([
      ["AGENT", "STATUS", "VERSION", "EXECUTABLE"],
      ...agents.map((agent) => [
        agent.label,
        agent.installed ? "ready" : "not installed",
        agent.version ?? "-",
        agent.executable ?? "-",
      ]),
    ]),
  );
  console.log("\nMuxtra currently supports managed launches for Claude Code and Codex CLI.");
}
