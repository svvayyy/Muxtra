import { randomUUID } from "node:crypto";
import { runProjectChecks, type CheckReport } from "../checks.js";
import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import {
  addWorktree,
  forceRemoveWorktree,
  gitBranch,
  gitHead,
  gitStatus,
  removeWorktree,
} from "../git.js";
import { managedWorktreePath } from "../paths.js";
import { run, runShellCapture } from "../process.js";
import { printJson } from "../protocol.js";
import { readState, recordGreen, recordIntegration, type IntegrationRecord } from "../state.js";
import { getWorkspaceStatuses, type WorkspaceStatus } from "../workspaces.js";

export interface CombineOptions {
  json?: boolean;
  abort?: boolean;
}

export interface CombineReport {
  ok: boolean;
  status: IntegrationRecord["status"];
  integration: IntegrationRecord;
  checks: CheckReport | null;
  appliedBranch: string | null;
  message: string;
}

export async function combineCommand(
  cwd: string,
  requestedNames: string[],
  options: CombineOptions,
): Promise<void> {
  const report = options.abort
    ? await abortCombination(cwd)
    : await combineWorkspaces(cwd, requestedNames, options);

  if (options.json) printJson("combine", report);
  else printCombineReport(report);

  if (!report.ok) throw new CliError(report.message, 2);
}

/**
 * Compose verified task branches in a temporary worktree. The primary checkout is only
 * fast-forwarded after the selected commits merge cleanly and the combined checks pass.
 */
export async function combineWorkspaces(
  cwd: string,
  requestedNames: string[] = [],
  options: Pick<CombineOptions, "json"> = {},
): Promise<CombineReport> {
  const { root, config } = await loadConfig(cwd);
  const state = await readState(root);
  if (
    state.integration &&
    ["combining", "checking", "conflict", "failed"].includes(state.integration.status)
  ) {
    throw new CliError(
      `Integration ${state.integration.id} still needs attention at ${state.integration.worktree}. ` +
        'Resolve it or run "muxtra combine --abort" before starting another.',
    );
  }

  const currentBranch = await gitBranch(root);
  if (currentBranch !== config.repository.default_branch) {
    throw new CliError(
      `Open the primary checkout on ${config.repository.default_branch} before combining work. ` +
        `Current branch: ${currentBranch}.`,
    );
  }
  if (await gitStatus(root)) {
    throw new CliError(
      "The primary project has local changes. Save or commit them before combining agent work.",
    );
  }
  if (config.checks.length === 0) {
    throw new CliError("Configure at least one project check before combining agent work.");
  }

  const snapshot = await getWorkspaceStatuses(root);
  const selected = selectWorkspaces(snapshot.workspaces, requestedNames);
  validateSelectedWorkspaces(selected);

  const baseSha = await gitHead(root);
  const id = randomUUID().slice(0, 8);
  const branch = `muxtra/integration/${id}`;
  const worktree = managedWorktreePath(root, config.project.name, `integration-${id}`);
  const now = new Date().toISOString();
  let integration: IntegrationRecord = {
    id,
    branch,
    worktree,
    workspaceIds: selected.map((workspace) => workspace.id),
    workspaceNames: selected.map((workspace) => workspace.name),
    status: "combining",
    baseSha,
    conflicts: [],
    checksPassed: 0,
    checksTotal: config.checks.length,
    createdAt: now,
    updatedAt: now,
  };

  await addWorktree(root, worktree, branch, baseSha);
  await recordIntegration(root, integration);

  for (const workspace of selected) {
    try {
      await run("git", ["merge", "--no-ff", "--no-edit", workspace.observedBranch], worktree);
    } catch (error) {
      const conflicts = await conflictedFiles(worktree);
      integration = {
        ...integration,
        status: conflicts.length > 0 ? "conflict" : "failed",
        conflicts,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      };
      await recordIntegration(root, integration);
      return {
        ok: false,
        status: integration.status,
        integration,
        checks: null,
        appliedBranch: null,
        message:
          conflicts.length > 0
            ? `Agent changes overlap in ${conflicts.length} file(s). No work was applied to ${currentBranch}.`
            : `Could not combine ${workspace.name}. No work was applied to ${currentBranch}.`,
      };
    }
  }

  integration = {
    ...integration,
    status: "checking",
    updatedAt: new Date().toISOString(),
  };
  await recordIntegration(root, integration);

  if (config.runtime.install) {
    (options.json ? console.error : console.log)(`→ ${config.runtime.install}`);
    const installation = await runShellCapture(
      config.runtime.install,
      worktree,
      options.json ? process.stderr : process.stdout,
    );
    if (installation.code !== 0) {
      integration = {
        ...integration,
        status: "failed",
        error: `Candidate setup failed: ${config.runtime.install}`,
        updatedAt: new Date().toISOString(),
      };
      await recordIntegration(root, integration);
      return {
        ok: false,
        status: integration.status,
        integration,
        checks: null,
        appliedBranch: null,
        message: `The temporary result could not run ${config.runtime.install}. Nothing was applied to ${currentBranch}.`,
      };
    }
  }

  const checks = await runProjectChecks(worktree, { agent: "muxtra", json: options.json });
  if (!checks.ok) {
    const failedIndex = config.checks.indexOf(checks.failure.check);
    integration = {
      ...integration,
      status: "failed",
      checksPassed: Math.max(0, failedIndex),
      error: `Combined check failed: ${checks.failure.check}`,
      updatedAt: new Date().toISOString(),
    };
    await recordIntegration(root, integration);
    return {
      ok: false,
      status: integration.status,
      integration,
      checks,
      appliedBranch: null,
      message: `The combined result failed ${checks.failure.check}. Nothing was applied to ${currentBranch}.`,
    };
  }

  if (
    (await gitBranch(root)) !== currentBranch ||
    (await gitHead(root)) !== baseSha ||
    Boolean(await gitStatus(root))
  ) {
    integration = {
      ...integration,
      status: "failed",
      checksPassed: config.checks.length,
      error: "The primary project changed while the combined result was being verified.",
      updatedAt: new Date().toISOString(),
    };
    await recordIntegration(root, integration);
    return {
      ok: false,
      status: integration.status,
      integration,
      checks,
      appliedBranch: null,
      message: `The primary project changed during verification. Nothing was applied to ${currentBranch}.`,
    };
  }

  await run("git", ["merge", "--ff-only", branch], root);
  const combinedAt = new Date().toISOString();
  integration = {
    ...integration,
    status: "combined",
    checksPassed: config.checks.length,
    error: undefined,
    updatedAt: combinedAt,
  };
  await recordIntegration(root, integration, integration.workspaceIds);
  await recordGreen(root, {
    sha: await gitHead(root),
    branch: currentBranch,
    at: combinedAt,
    agent: "muxtra",
    checks: config.checks,
  });

  await cleanupCandidate(root, integration, false);
  return {
    ok: true,
    status: integration.status,
    integration,
    checks,
    appliedBranch: currentBranch,
    message: `Combined ${selected.length} task(s) into ${currentBranch}.`,
  };
}

export async function abortCombination(cwd: string): Promise<CombineReport> {
  const { root } = await loadConfig(cwd);
  const state = await readState(root);
  const integration = state.integration;
  if (
    !integration ||
    !["combining", "checking", "conflict", "failed"].includes(integration.status)
  ) {
    throw new CliError("There is no unfinished combination to abort.");
  }

  await cleanupCandidate(root, integration, true);
  const aborted: IntegrationRecord = {
    ...integration,
    status: "aborted",
    error: undefined,
    updatedAt: new Date().toISOString(),
  };
  await recordIntegration(root, aborted);
  return {
    ok: true,
    status: aborted.status,
    integration: aborted,
    checks: null,
    appliedBranch: null,
    message: "Discarded the temporary combined result. Agent task branches were retained.",
  };
}

export async function combineStatusCommand(cwd: string, asJson: boolean): Promise<void> {
  const { root } = await loadConfig(cwd);
  const integration = (await readState(root)).integration ?? null;
  if (asJson) {
    printJson("combine-status", integration);
    return;
  }
  if (!integration) {
    console.log("No combined result yet.");
    return;
  }
  console.log(`Result: ${integration.status}`);
  console.log(`Tasks: ${integration.workspaceNames.join(", ")}`);
  if (["combining", "checking", "conflict", "failed"].includes(integration.status)) {
    console.log(`Temporary result: ${integration.worktree}`);
  }
}

function selectWorkspaces(
  statuses: WorkspaceStatus[],
  requestedNames: string[],
): WorkspaceStatus[] {
  if (requestedNames.length === 0) {
    const ready = statuses.filter(
      (workspace) => workspace.readySha === workspace.head && !workspace.combinedAt,
    );
    if (ready.length === 0) {
      throw new CliError(
        'No verified tasks are ready. Have each agent commit its work and run "muxtra finish".',
      );
    }
    return ready;
  }

  const names = [...new Set(requestedNames)];
  return names.map((name) => {
    const workspace = statuses.find((candidate) => candidate.name === name);
    if (!workspace) throw new CliError(`Unknown workspace: ${name}`);
    return workspace;
  });
}

function validateSelectedWorkspaces(workspaces: WorkspaceStatus[]): void {
  for (const workspace of workspaces) {
    if (workspace.combinedAt) throw new CliError(`Task ${workspace.name} was already combined.`);
    if (!workspace.readySha) {
      throw new CliError(
        `Task ${workspace.name} has not finished verification. ` +
          `Its agent should commit the work and run "muxtra finish ${workspace.name}".`,
      );
    }
    if (workspace.readySha !== workspace.head) {
      throw new CliError(
        `Task ${workspace.name} changed after it was verified. Run "muxtra finish ${workspace.name}" again.`,
      );
    }
    if (!["committed", "stale"].includes(workspace.state)) {
      throw new CliError(
        `Task ${workspace.name} is ${workspace.state}, not ready to combine. Run "muxtra status" for details.`,
      );
    }
    if (workspace.observedBranch !== workspace.branch) {
      throw new CliError(`Task ${workspace.name} is on an unexpected branch.`);
    }
    if (workspace.development?.alive) {
      throw new CliError(`Stop the preview for ${workspace.name} before combining it.`);
    }
  }
}

async function conflictedFiles(worktree: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["diff", "--name-only", "--diff-filter=U"], worktree);
    return stdout ? stdout.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function cleanupCandidate(
  root: string,
  integration: IntegrationRecord,
  force: boolean,
): Promise<void> {
  if (force) {
    await run("git", ["merge", "--abort"], integration.worktree).catch(() => undefined);
    await forceRemoveWorktree(root, integration.worktree).catch(() => undefined);
    await run("git", ["branch", "-D", integration.branch], root).catch(() => undefined);
    return;
  }

  await removeWorktree(root, integration.worktree).catch(async (error) => {
    console.warn(`Warning: combined successfully but could not remove ${integration.worktree}.`);
    console.warn(error instanceof Error ? error.message : String(error));
    await forceRemoveWorktree(root, integration.worktree).catch((forceError) => {
      console.warn(`Warning: could not force-remove ${integration.worktree}.`);
      console.warn(forceError instanceof Error ? forceError.message : String(forceError));
    });
  });
  await run("git", ["branch", "-d", integration.branch], root).catch((error) => {
    console.warn(`Warning: combined successfully but could not delete ${integration.branch}.`);
    console.warn(error instanceof Error ? error.message : String(error));
  });
}

function printCombineReport(report: CombineReport): void {
  if (report.ok && report.status === "combined") {
    console.log(`\n✓ ${report.message}`);
    console.log(`  checks: ${report.integration.checksPassed}/${report.integration.checksTotal}`);
    console.log(`  tasks: ${report.integration.workspaceNames.join(", ")}`);
    console.log("  every selected task branch was retained");
    return;
  }
  if (report.ok && report.status === "aborted") {
    console.log(`\n✓ ${report.message}`);
    return;
  }

  console.error(`\n✖ ${report.message}`);
  if (report.integration.conflicts.length > 0) {
    console.error("  conflicting files:");
    for (const file of report.integration.conflicts) console.error(`    ${file}`);
  }
  console.error(`  temporary result: ${report.integration.worktree}`);
  console.error("  discard it with: muxtra combine --abort");
}
