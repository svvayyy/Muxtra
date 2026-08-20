import { CliError } from "../errors.js";
import { gitRoot } from "../git.js";
import { recordAgentPhase, type WorkspaceAgentPhase } from "../state.js";

const phases = new Set<WorkspaceAgentPhase>(["working", "waiting", "needs_input"]);

/** Internal lifecycle endpoint used by provider hooks. Intentionally silent. */
export async function agentStatusCommand(cwd: string, requestedPhase: string): Promise<void> {
  if (!phases.has(requestedPhase as WorkspaceAgentPhase)) {
    throw new CliError(`Unknown agent lifecycle state: ${requestedPhase}`);
  }
  const workspace = process.env.MUXTRA_WORKSPACE;
  const sessionId = process.env.MUXTRA_SESSION_ID;
  if (!workspace || !sessionId) {
    throw new CliError("Agent lifecycle updates require a Muxtra-managed session.");
  }

  await recordAgentPhase(
    await gitRoot(cwd),
    workspace,
    sessionId,
    requestedPhase as WorkspaceAgentPhase,
  );
}
