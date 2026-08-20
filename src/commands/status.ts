import { table } from "../format.js";
import { printJson } from "../protocol.js";
import { getWorkspaceStatuses, type WorkspaceStatus } from "../workspaces.js";

export async function statusCommand(
  cwd: string,
  asJson: boolean,
  fetch: boolean,
  details = false,
): Promise<void> {
  const snapshot = await getWorkspaceStatuses(cwd, { fetch });
  if (fetch && !snapshot.fetched) console.warn("Warning: origin is not configured; skipped fetch.");
  const statuses = snapshot.workspaces;

  if (asJson) {
    printJson("status", statuses);
    return;
  }

  if (statuses.length === 0) {
    console.log('No active tasks. Start one with: muxtra start "Describe the task" --agent codex');
    return;
  }

  if (details) {
    console.log(
      table([
        [
          "WORKSPACE",
          "AGENT",
          "SESSION",
          "BRANCH",
          "STATE",
          "DEV",
          "SERVER",
          "AHEAD",
          "BEHIND",
          "HEAD",
        ],
        ...statuses.map((workspace) => [
          workspace.name,
          workspace.agent,
          workspace.agentActivity?.observedState ?? "-",
          workspace.observedBranch,
          workspace.state,
          workspace.development?.observedState ?? "-",
          workspace.development?.alive ? `:${workspace.development.port}` : "-",
          String(workspace.ahead),
          String(workspace.behind),
          workspace.head?.slice(0, 12) ?? "-",
        ]),
      ]),
    );
  } else {
    console.log(
      table([
        ["TASK", "AGENT", "STATUS", "PREVIEW"],
        ...statuses.map((workspace) => [
          workspace.task ?? workspace.name,
          workspace.agent,
          humanStatus(workspace),
          workspace.development?.alive ? workspace.development.url : "-",
        ]),
      ]),
    );
    console.log("\nRun muxtra status --details for Git and workspace diagnostics.");
  }

  const stale = statuses.filter(
    (workspace) => workspace.behind > 0 && workspace.state !== "combined",
  );
  if (stale.length > 0) {
    console.warn(
      `\nWarning: ${stale.length} workspace(s) are behind their recorded base. ` +
        "Synchronize and rerun checks before integration or deployment.",
    );
  }
}

function humanStatus(workspace: WorkspaceStatus): string {
  if (workspace.agentActivity?.observedState === "running") return "agent running";
  if (workspace.agentActivity?.observedState === "needs_input") return "agent needs you";
  if (workspace.agentActivity?.observedState === "waiting") return "agent idle";
  if (!workspace.dirty && workspace.agentActivity?.observedState === "active") {
    return "agent active";
  }

  switch (workspace.state) {
    case "clean":
      return "ready to start";
    case "working":
      return "working";
    case "committed":
      return "changes ready";
    case "stale":
      return "needs update";
    case "stale+working":
      return "working; needs update";
    case "combined":
      return "combined";
    case "missing":
      return "workspace missing";
  }
}
