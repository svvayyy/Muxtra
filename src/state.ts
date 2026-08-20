import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CliError } from "./errors.js";
import { gitCommonDir } from "./git.js";
import { isProcessAlive } from "./runtime.js";

export interface WorkspaceRecord {
  id: string;
  name: string;
  agent: string;
  /** The user's plain-language assignment. Used by the CLI today and the app later. */
  task?: string;
  /** Optional user-facing title; `name` remains the stable CLI identifier. */
  displayName?: string;
  /** Local image files passed to the selected agent when this workspace launches. */
  attachments?: string[];
  /** The kind of work this task is expected to own. */
  lane?: "design" | "code";
  /** Exact provider model requested for this task. */
  model?: string;
  /** Connects separately isolated design and code tasks created together. */
  teamId?: string;
  peerWorkspaces?: string[];
  branch: string;
  baseRef: string;
  baseSha: string;
  worktree: string;
  managed?: boolean;
  createdAt: string;
  readyAt?: string;
  readySha?: string;
  combinedAt?: string;
  integrationId?: string;
  development?: WorkspaceDevelopmentProcess;
  agentActivity?: WorkspaceAgentActivity;
}

export interface WorkspaceAgentActivity {
  sessionId: string;
  agent: string;
  source: "managed" | "attached";
  status: "running" | "active" | "exited";
  /** Provider lifecycle state. A live process can be waiting at its prompt. */
  phase?: "working" | "waiting" | "needs_input";
  startedAt: string;
  lastSeenAt: string;
  pid?: number;
  exitedAt?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
}

export type WorkspaceAgentPhase = NonNullable<WorkspaceAgentActivity["phase"]>;

export type IntegrationStatus =
  "combining" | "checking" | "conflict" | "failed" | "combined" | "aborted";

export interface IntegrationRecord {
  id: string;
  branch: string;
  worktree: string;
  workspaceIds: string[];
  workspaceNames: string[];
  status: IntegrationStatus;
  baseSha: string;
  conflicts: string[];
  checksPassed: number;
  checksTotal: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceDevelopmentProcess {
  pid: number;
  port: number;
  command: string;
  url: string;
  logPath: string;
  environmentProvider: "inherit" | "vercel";
  environmentTarget: string;
  status: "running" | "stopped";
  startedAt: string;
  stoppedAt?: string;
}

export interface GreenRecord {
  sha: string;
  branch: string;
  at: string;
  agent: string;
  checks: string[];
}

export interface WorkspaceState {
  version: 1;
  workspaces: WorkspaceRecord[];
  laneDefaults?: {
    design?: WorkspaceLaneSelection;
    code?: WorkspaceLaneSelection;
  };
  integration?: IntegrationRecord;
  green?: GreenRecord;
}

export interface WorkspaceLaneSelection {
  agent: "claude" | "codex";
  model?: string;
}

async function statePath(cwd: string): Promise<string> {
  const commonDir = await gitCommonDir(cwd);
  const current = path.join(commonDir, "muxtra", "state.json");
  const legacy = path.join(commonDir, "parallel-agent", "state.json");
  try {
    await stat(current);
    return current;
  } catch {
    try {
      await stat(legacy);
      return legacy;
    } catch {
      return current;
    }
  }
}

export async function readState(cwd: string): Promise<WorkspaceState> {
  const filePath = await statePath(cwd);
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as WorkspaceState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, workspaces: [] };
    }
    throw error;
  }
}

async function writeState(cwd: string, state: WorkspaceState): Promise<void> {
  const filePath = await statePath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

export async function addWorkspace(cwd: string, workspace: WorkspaceRecord): Promise<void> {
  await mutateState(cwd, (state) => {
    state.workspaces.push(workspace);
  });
}

export async function updateWorkspace(
  cwd: string,
  workspaceId: string,
  update: (workspace: WorkspaceRecord) => WorkspaceRecord,
): Promise<WorkspaceRecord> {
  let updated: WorkspaceRecord | undefined;
  await mutateState(cwd, (state) => {
    const index = state.workspaces.findIndex((workspace) => workspace.id === workspaceId);
    if (index === -1) {
      throw new CliError(`Workspace disappeared from state: ${workspaceId}`);
    }
    updated = update(state.workspaces[index]);
    state.workspaces[index] = updated;
  });
  return updated!;
}

export async function recordManagedAgentLaunch(
  cwd: string,
  workspaceId: string,
  activity: WorkspaceAgentActivity,
): Promise<void> {
  await updateWorkspace(cwd, workspaceId, (workspace) => ({
    ...workspace,
    agentActivity: activity,
  }));
}

export async function setLaneDefault(
  cwd: string,
  lane: "design" | "code",
  selection: WorkspaceLaneSelection,
): Promise<void> {
  await mutateState(cwd, (state) => {
    state.laneDefaults = { ...state.laneDefaults, [lane]: selection };
  });
}

export async function touchWorkspaceAgent(
  cwd: string,
  workspaceName: string,
  agent: string,
  source: WorkspaceAgentActivity["source"] = "attached",
  now = new Date(),
): Promise<WorkspaceAgentActivity> {
  let activity: WorkspaceAgentActivity | undefined;
  await mutateState(cwd, (state) => {
    const workspace = state.workspaces.find((candidate) => candidate.name === workspaceName);
    if (!workspace) throw new CliError(`Unknown workspace: ${workspaceName}`);

    const existing = workspace.agentActivity;
    const preserveManaged =
      existing?.source === "managed" &&
      existing.status === "running" &&
      existing.pid !== undefined &&
      isProcessAlive(existing.pid);
    const continuesAttached =
      existing?.source === "attached" && existing.status === "active" && existing.agent === agent;
    activity = {
      sessionId: preserveManaged || continuesAttached ? existing.sessionId : randomUUID(),
      agent,
      source: preserveManaged ? "managed" : source,
      status: preserveManaged ? "running" : "active",
      startedAt: preserveManaged || continuesAttached ? existing.startedAt : now.toISOString(),
      lastSeenAt: now.toISOString(),
      ...(preserveManaged && existing?.pid ? { pid: existing.pid } : {}),
    };
    workspace.agentActivity = activity;
  });
  return activity!;
}

export async function recordAgentExit(
  cwd: string,
  workspaceId: string,
  sessionId: string,
  result: { code: number | null; signal: NodeJS.Signals | null },
): Promise<void> {
  await updateWorkspace(cwd, workspaceId, (workspace) => {
    if (workspace.agentActivity?.sessionId !== sessionId) return workspace;
    const now = new Date().toISOString();
    return {
      ...workspace,
      agentActivity: {
        ...workspace.agentActivity,
        status: "exited",
        lastSeenAt: now,
        exitedAt: now,
        ...(result.code === null ? {} : { exitCode: result.code }),
        ...(result.signal === null ? {} : { signal: result.signal }),
      },
    };
  });
}

/**
 * Records a provider lifecycle transition without trusting a stale terminal.
 * Claude hooks inherit the session id Muxtra assigned at launch, so an older
 * process cannot make a replacement session look busy or idle.
 */
export async function recordAgentPhase(
  cwd: string,
  workspaceName: string,
  sessionId: string,
  phase: WorkspaceAgentPhase,
): Promise<boolean> {
  let updated = false;
  await mutateState(cwd, (state) => {
    const workspace = state.workspaces.find((candidate) => candidate.name === workspaceName);
    if (!workspace) throw new CliError(`Unknown workspace: ${workspaceName}`);
    if (
      workspace.agentActivity?.sessionId !== sessionId ||
      workspace.agentActivity.status !== "running"
    ) {
      return;
    }

    workspace.agentActivity = {
      ...workspace.agentActivity,
      phase,
      lastSeenAt: new Date().toISOString(),
    };
    updated = true;
  });
  return updated;
}

export async function removeWorkspace(cwd: string, workspaceId: string): Promise<WorkspaceRecord> {
  let removed: WorkspaceRecord | undefined;
  await mutateState(cwd, (state) => {
    const index = state.workspaces.findIndex((workspace) => workspace.id === workspaceId);
    if (index === -1) {
      throw new CliError(`Workspace disappeared from state: ${workspaceId}`);
    }
    [removed] = state.workspaces.splice(index, 1);
  });
  return removed!;
}

async function mutateState(cwd: string, mutate: (state: WorkspaceState) => void): Promise<void> {
  const filePath = await statePath(cwd);
  const lockPath = `${filePath}.lock`;
  await mkdir(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + 5_000;
  let lock: Awaited<ReturnType<typeof open>> | undefined;

  while (!lock && Date.now() < deadline) {
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > 30_000) {
          await unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      await delay(25 + Math.floor(Math.random() * 25));
    }
  }

  if (!lock) {
    throw new CliError("Timed out waiting for another Muxtra state update.");
  }

  try {
    const state = await readState(cwd);
    mutate(state);
    await writeState(cwd, state);
  } finally {
    await lock.close();
    await unlink(lockPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

/** Records the last commit at which every configured check passed. */
export async function recordGreen(cwd: string, green: GreenRecord): Promise<void> {
  await mutateState(cwd, (state) => {
    state.green = green;
  });
}

export async function readGreen(cwd: string): Promise<GreenRecord | null> {
  return (await readState(cwd)).green ?? null;
}

export async function recordIntegration(
  cwd: string,
  integration: IntegrationRecord,
  combinedWorkspaceIds: string[] = [],
): Promise<void> {
  await mutateState(cwd, (state) => {
    state.integration = integration;
    if (integration.status !== "combined") return;
    for (const workspace of state.workspaces) {
      if (!combinedWorkspaceIds.includes(workspace.id)) continue;
      workspace.combinedAt = integration.updatedAt;
      workspace.integrationId = integration.id;
    }
  });
}
