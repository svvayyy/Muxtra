import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CliError } from "./errors.js";
import { slugify } from "./format.js";
import { commandExists } from "./process.js";

const execFileAsync = promisify(execFile);

export type StableAgent = "claude" | "codex";

export interface AgentDefinition {
  id: StableAgent;
  label: string;
  command: string;
  aliases: readonly string[];
}

export interface AgentInstallation extends AgentDefinition {
  installed: boolean;
  executable: string | null;
  version: string | null;
}

/**
 * The deliberately small compatibility surface Muxtra promises today.
 * New providers belong here only after their interactive launch and workspace
 * behavior are covered by tests.
 */
export const stableAgents: readonly AgentDefinition[] = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    aliases: ["claude", "claude-code"],
  },
  {
    id: "codex",
    label: "Codex CLI",
    command: "codex",
    aliases: ["codex", "codex-cli"],
  },
];

const aliases = new Map(
  stableAgents.flatMap((definition) =>
    definition.aliases.map((alias) => [slugify(alias), definition.id] as const),
  ),
);

export function normalizeStableAgent(rawAgent: string): StableAgent {
  const normalized = aliases.get(slugify(rawAgent));
  if (!normalized) {
    throw new CliError(
      `No stable interactive launcher is configured for agent "${rawAgent}". ` +
        "Supported launchers: claude, codex. Use muxtra instructions for other clients.",
    );
  }
  return normalized;
}

export async function discoverAgentInstallations(): Promise<AgentInstallation[]> {
  return Promise.all(
    stableAgents.map(async (definition) => {
      const installed = await commandExists(definition.command);
      if (!installed) {
        return { ...definition, installed: false, executable: null, version: null };
      }

      const [executable, version] = await Promise.all([
        commandOutput(process.platform === "win32" ? "where" : "which", [definition.command]),
        commandOutput(definition.command, ["--version"]),
      ]);
      return {
        ...definition,
        installed: true,
        executable: executable?.split(/\r?\n/, 1)[0] ?? definition.command,
        version,
      };
    }),
  );
}

async function commandOutput(command: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim() || result.stderr.trim() || null;
  } catch {
    return null;
  }
}
