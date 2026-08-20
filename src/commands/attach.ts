import { normalizeStableAgent } from "../agents.js";
import { resolveIdentity } from "../identity.js";
import { printJson } from "../protocol.js";
import { touchWorkspaceAgent } from "../state.js";
import { resolveWorkspaceStatus } from "../workspaces.js";

export async function attachCommand(
  cwd: string,
  requestedName: string | undefined,
  options: { agent?: string; json?: boolean },
): Promise<void> {
  const resolved = await resolveWorkspaceStatus(cwd, requestedName);
  const identity = await resolveIdentity(resolved.root, options.agent);
  const agent = normalizeStableAgent(
    options.agent ?? (identity.source === "unknown" ? resolved.workspace.agent : identity.agent),
  );
  const activity = await touchWorkspaceAgent(
    resolved.root,
    resolved.workspace.name,
    agent,
    "attached",
  );

  const result = {
    workspace: resolved.workspace.name,
    worktree: resolved.workspace.worktree,
    agent,
    activity,
  };
  if (options.json) {
    printJson("attach", result);
    return;
  }

  console.log(`✓ ${agent === "claude" ? "Claude Code" : "Codex CLI"} attached`);
  console.log(`Workspace: ${resolved.workspace.name}`);
  console.log(`Worktree: ${resolved.workspace.worktree}`);
  console.log("Muxtra will now reflect this agent's workspace activity in status.");
}
