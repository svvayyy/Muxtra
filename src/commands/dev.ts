import { access } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { aheadBehind } from "../git.js";
import { workspaceLogPath } from "../paths.js";
import { commandExists } from "../process.js";
import {
  allocatePort,
  isProcessAlive,
  prepareVercelProjectLink,
  startDevelopmentProcess,
  waitForHttp,
} from "../runtime.js";
import { readState, updateWorkspace } from "../state.js";

export interface DevOptions {
  port?: string;
  wait: boolean;
}

export async function devCommand(
  cwd: string,
  requestedName: string | undefined,
  options: DevOptions,
): Promise<void> {
  const { root, config } = await loadConfig(cwd);
  if (!config.runtime.development) {
    throw new CliError("runtime.development is not configured in .muxtra/project.yaml.");
  }
  const state = await readState(root);
  const currentRoot = await currentGitRoot(cwd);
  const workspace = requestedName
    ? state.workspaces.find((candidate) => candidate.name === requestedName)
    : state.workspaces.find((candidate) => candidate.worktree === currentRoot);
  if (!workspace) {
    throw new CliError(
      requestedName
        ? `Unknown workspace: ${requestedName}`
        : "Could not infer a workspace from this directory. Pass a workspace name.",
    );
  }
  try {
    await access(workspace.worktree);
  } catch {
    throw new CliError(`Workspace worktree is missing: ${workspace.worktree}`);
  }
  if (workspace.development?.status === "running" && isProcessAlive(workspace.development.pid)) {
    throw new CliError(
      `Workspace ${workspace.name} already has a development process at ${workspace.development.url}.`,
    );
  }

  const delta = await aheadBehind(workspace.worktree, workspace.baseRef);
  if (delta.behind > 0) {
    console.warn(
      `Warning: ${workspace.name} is ${delta.behind} commit(s) behind ${workspace.baseRef}. ` +
        "Local testing is allowed, but integration and deployment remain unsafe.",
    );
  }

  const requestedPort = options.port === undefined ? undefined : Number(options.port);
  const port = await allocatePort(requestedPort);
  const provider = config.runtime.environment.provider;
  const target = config.runtime.environment.target;
  if (provider === "vercel") {
    if (!(await commandExists("vercel"))) {
      throw new CliError(
        "Vercel environment injection is configured, but vercel is not installed.",
      );
    }
    await prepareVercelProjectLink(root, workspace.worktree);
  }

  const healthPath = config.runtime.healthcheck?.startsWith("/")
    ? config.runtime.healthcheck
    : `/${config.runtime.healthcheck ?? ""}`;
  const url = `http://localhost:${port}${healthPath}`;
  const logPath = workspaceLogPath(root, config.project.name, workspace.name);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    [config.runtime.port_env]: String(port),
    MUXTRA_PORT: String(port),
    MUXTRA_WORKSPACE: workspace.name,
  };
  const startedAt = new Date().toISOString();
  const pid = await startDevelopmentProcess({
    command: config.runtime.development,
    cwd: workspace.worktree,
    logPath,
    environment,
    environmentProvider: provider,
    environmentTarget: target,
  });

  await updateWorkspace(root, workspace.id, (current) => ({
    ...current,
    development: {
      pid,
      port,
      command: config.runtime.development!,
      url,
      logPath,
      environmentProvider: provider,
      environmentTarget: target,
      status: "running",
      startedAt,
    },
  }));

  const readiness = options.wait ? await waitForHttp(url, pid) : "timeout";
  if (readiness === "exited") {
    await updateWorkspace(root, workspace.id, (current) => ({
      ...current,
      development: current.development
        ? { ...current.development, status: "stopped", stoppedAt: new Date().toISOString() }
        : undefined,
    }));
    throw new CliError(`Development process exited during startup. Inspect ${logPath}.`);
  }

  console.log(`Started development server for ${workspace.name}`);
  console.log(`PID: ${pid}`);
  console.log(`URL: ${url}`);
  console.log(`Environment: ${provider}${provider === "vercel" ? ` (${target})` : ""}`);
  console.log(`Logs: ${logPath}`);
  if (readiness === "timeout" && options.wait) {
    console.warn(
      "Warning: the process is running, but the health URL was not ready after 15 seconds.",
    );
  }
}

async function currentGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { gitRoot } = await import("../git.js");
    return await gitRoot(cwd);
  } catch {
    return undefined;
  }
}
