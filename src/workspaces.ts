import { access } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { CliError } from "./errors.js";
import {
  aheadBehind,
  changedFiles,
  fetchOrigin,
  gitBranch,
  gitHead,
  gitRoot,
  gitStatus,
} from "./git.js";
import { isProcessAlive } from "./runtime.js";
import { pathsReferToSameLocation } from "./paths.js";
import {
  readState,
  type WorkspaceAgentActivity,
  type WorkspaceDevelopmentProcess,
  type WorkspaceRecord,
} from "./state.js";

export type WorkspaceCondition =
  "clean" | "working" | "committed" | "stale" | "stale+working" | "combined" | "missing";

export interface ObservedDevelopmentProcess extends WorkspaceDevelopmentProcess {
  alive: boolean;
  observedState: "running" | "stopped" | "exited" | "unknown";
}

export interface ObservedAgentActivity extends WorkspaceAgentActivity {
  alive: boolean | null;
  idleSeconds: number;
  observedState: "running" | "waiting" | "needs_input" | "active" | "inactive" | "exited";
}

export interface WorkspaceStatus extends Omit<WorkspaceRecord, "development" | "agentActivity"> {
  development: ObservedDevelopmentProcess | null;
  agentActivity: ObservedAgentActivity | null;
  head: string | null;
  observedBranch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  state: WorkspaceCondition;
  changedFiles: string[];
}

export interface WorkspaceStatusSnapshot {
  root: string;
  fetched: boolean;
  workspaces: WorkspaceStatus[];
}

export async function getWorkspaceStatuses(
  cwd: string,
  options: { fetch?: boolean } = {},
): Promise<WorkspaceStatusSnapshot> {
  const { root } = await loadConfig(cwd);
  let fetched = false;
  if (options.fetch) fetched = await fetchOrigin(root);

  const state = await readState(root);
  const workspaces = await Promise.all(
    state.workspaces.map((workspace) => inspectWorkspace(workspace)),
  );
  return { root, fetched, workspaces };
}

export async function resolveWorkspaceStatus(
  cwd: string,
  requestedName?: string,
  options: { fetch?: boolean } = {},
): Promise<{ root: string; fetched: boolean; workspace: WorkspaceStatus }> {
  const snapshot = await getWorkspaceStatuses(cwd, options);
  const currentRoot = requestedName ? undefined : await gitRoot(cwd);
  let workspace = requestedName
    ? snapshot.workspaces.find((candidate) => candidate.name === requestedName)
    : undefined;
  if (!workspace && currentRoot) {
    for (const candidate of snapshot.workspaces) {
      if (await pathsReferToSameLocation(candidate.worktree, currentRoot)) {
        workspace = candidate;
        break;
      }
    }
  }

  if (!workspace) {
    throw new CliError(
      requestedName
        ? `Unknown workspace: ${requestedName}`
        : "Could not infer a workspace from this directory. Pass a workspace name.",
    );
  }
  return { root: snapshot.root, fetched: snapshot.fetched, workspace };
}

async function inspectWorkspace(workspace: WorkspaceRecord): Promise<WorkspaceStatus> {
  try {
    await access(workspace.worktree);
    const [head, observedBranch, dirtyStatus, delta, files] = await Promise.all([
      gitHead(workspace.worktree),
      gitBranch(workspace.worktree),
      gitStatus(workspace.worktree),
      aheadBehind(workspace.worktree, workspace.baseRef),
      changedFiles(workspace.worktree, workspace.baseSha),
    ]);
    const dirty = dirtyStatus.length > 0;
    const development = observeDevelopment(workspace.development);
    const agentActivity = observeAgentActivity(workspace.agentActivity);
    const repositoryState: WorkspaceCondition =
      delta.behind > 0
        ? dirty
          ? "stale+working"
          : workspace.combinedAt
            ? "combined"
            : "stale"
        : dirty
          ? "working"
          : workspace.combinedAt
            ? "combined"
            : delta.ahead > 0
              ? "committed"
              : "clean";
    const sessionIsActive =
      agentActivity?.observedState === "running" || agentActivity?.observedState === "active";
    return {
      ...workspace,
      development,
      agentActivity,
      head,
      observedBranch,
      dirty,
      changedFiles: files,
      ahead: delta.ahead,
      behind: delta.behind,
      // A clean but attached workspace is still active work. Keeping that in the
      // existing state field lets older app clients reflect the session without
      // understanding the richer agentActivity object yet; `dirty` remains the
      // source of truth for uncommitted files.
      state: repositoryState === "clean" && sessionIsActive ? "working" : repositoryState,
    };
  } catch {
    return {
      ...workspace,
      development: workspace.development
        ? { ...workspace.development, alive: false, observedState: "unknown" }
        : null,
      agentActivity: observeAgentActivity(workspace.agentActivity),
      head: null,
      observedBranch: workspace.branch,
      dirty: false,
      changedFiles: [],
      ahead: 0,
      behind: 0,
      state: "missing",
    };
  }
}

const ATTACHED_ACTIVITY_WINDOW_SECONDS = 30 * 60;

function observeAgentActivity(
  activity: WorkspaceAgentActivity | undefined,
): ObservedAgentActivity | null {
  if (!activity) return null;
  const idleSeconds = Math.max(0, (Date.now() - Date.parse(activity.lastSeenAt)) / 1_000);
  const alive = activity.pid === undefined ? null : isProcessAlive(activity.pid);
  let observedState: ObservedAgentActivity["observedState"];
  if (activity.status === "exited" || (activity.status === "running" && alive === false)) {
    observedState = "exited";
  } else if (activity.status === "running" && activity.phase === "needs_input") {
    observedState = "needs_input";
  } else if (activity.status === "running" && activity.phase === "waiting") {
    observedState = "waiting";
  } else if (
    activity.status === "running" &&
    alive &&
    activity.agent === "claude" &&
    activity.phase === undefined
  ) {
    // Sessions launched before lifecycle hooks were added only have a PID.
    // Treat those legacy Claude prompts as idle instead of preserving the old
    // permanent "Working" spinner. New launches always record an initial phase.
    observedState = "waiting";
  } else if (activity.status === "running" && alive) {
    observedState = "running";
  } else if (idleSeconds <= ATTACHED_ACTIVITY_WINDOW_SECONDS) {
    observedState = "active";
  } else {
    observedState = "inactive";
  }
  return { ...activity, alive, idleSeconds, observedState };
}

function observeDevelopment(
  development: WorkspaceDevelopmentProcess | undefined,
): ObservedDevelopmentProcess | null {
  if (!development) return null;
  const alive = development.status === "running" && isProcessAlive(development.pid);
  return {
    ...development,
    alive,
    observedState: development.status === "stopped" ? "stopped" : alive ? "running" : "exited",
  };
}
