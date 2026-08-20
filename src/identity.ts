import { realpath } from "node:fs/promises";
import path from "node:path";
import { readState } from "./state.js";

export interface AgentIdentity {
  agent: string;
  workspace: string | null;
  source: "flag" | "environment" | "workspace" | "unknown";
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

async function isInside(parent: string, child: string): Promise<boolean> {
  const relative = path.relative(await canonicalPath(parent), await canonicalPath(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Who is running this command. `muxtra launch` exports both variables, so an agent it
 * started is identified with no further ceremony; an agent a human started by hand
 * falls back to its registered workspace, then to `--agent`.
 */
export async function resolveIdentity(cwd: string, override?: string): Promise<AgentIdentity> {
  const workspaceNameFromEnvironment =
    process.env.MUXTRA_WORKSPACE?.trim() || process.env.PARALLEL_AGENT_WORKSPACE?.trim() || null;
  let registeredWorkspace: { agent: string; name: string } | null = null;
  let environmentWorkspace: { agent: string; name: string } | null = null;
  let stateWasReadable = false;

  try {
    const state = await readState(cwd);
    stateWasReadable = true;
    let match: (typeof state.workspaces)[number] | undefined;
    for (const workspace of state.workspaces) {
      if (await isInside(workspace.worktree, cwd)) {
        match = workspace;
        break;
      }
    }
    if (match) registeredWorkspace = { agent: match.agent, name: match.name };
    const environmentMatch = workspaceNameFromEnvironment
      ? state.workspaces.find((workspace) => workspace.name === workspaceNameFromEnvironment)
      : undefined;
    if (environmentMatch) {
      environmentWorkspace = { agent: environmentMatch.agent, name: environmentMatch.name };
    }
  } catch {
    // A repository without state simply has no registered workspaces.
  }

  // A launched agent can invoke tools that create or enter another repository. Only trust
  // its inherited workspace name when that workspace belongs to the repository at `cwd`.
  const workspace =
    registeredWorkspace?.name ??
    environmentWorkspace?.name ??
    (stateWasReadable ? null : workspaceNameFromEnvironment);

  if (override?.trim()) {
    return { agent: override.trim(), workspace, source: "flag" };
  }

  if (registeredWorkspace) {
    return {
      agent: registeredWorkspace.agent,
      workspace: registeredWorkspace.name,
      source: "workspace",
    };
  }

  const fromEnvironment =
    process.env.MUXTRA_AGENT?.trim() || process.env.PARALLEL_AGENT_AGENT?.trim();
  if (fromEnvironment && (environmentWorkspace || !stateWasReadable)) {
    return { agent: fromEnvironment, workspace, source: "environment" };
  }

  if (environmentWorkspace) {
    return {
      agent: environmentWorkspace.agent,
      workspace: environmentWorkspace.name,
      source: "environment",
    };
  }

  return { agent: "unknown", workspace, source: "unknown" };
}
