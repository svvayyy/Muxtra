import { runProjectChecks, type CheckReport } from "../checks.js";
import { claimsForIdentity, removeClaim } from "../claims.js";
import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { resolveIdentity } from "../identity.js";
import { printJson } from "../protocol.js";
import { updateWorkspace } from "../state.js";
import { resolveWorkspaceStatus, type WorkspaceStatus } from "../workspaces.js";

export interface FinishOptions {
  agent?: string;
  fetch?: boolean;
  json?: boolean;
}

export type FinishBlockerCode =
  | "workspace-missing"
  | "branch-mismatch"
  | "uncommitted-changes"
  | "no-commits"
  | "stale-base"
  | "development-running"
  | "checks-not-configured"
  | "checks-failed";

export interface FinishBlocker {
  code: FinishBlockerCode;
  message: string;
}

export interface FinishReport {
  ready: boolean;
  workspace: WorkspaceStatus;
  blockers: FinishBlocker[];
  checks: CheckReport | null;
  releasedClaims: number;
  next: string | null;
}

/**
 * Verify that a workspace is safe to hand off for integration. This intentionally
 * does not push, merge, remove, or deploy anything.
 */
export async function finishCommand(
  cwd: string,
  requestedName: string | undefined,
  options: FinishOptions,
): Promise<void> {
  const resolved = await resolveWorkspaceStatus(cwd, requestedName, { fetch: options.fetch });
  if (options.fetch && !resolved.fetched) {
    console.warn("Warning: origin is not configured; skipped fetch.");
  }

  const { config } = await loadConfig(resolved.workspace.worktree);
  let workspace = resolved.workspace;
  let blockers = readinessBlockers(workspace, config.checks.length);
  let checks: CheckReport | null = null;

  if (blockers.length === 0) {
    checks = await runProjectChecks(workspace.worktree, {
      agent: options.agent,
      json: options.json,
    });
    const refreshed = await resolveWorkspaceStatus(workspace.worktree, workspace.name);
    workspace = refreshed.workspace;
    blockers = readinessBlockers(workspace, config.checks.length);
    if (!checks.ok) {
      blockers.push({ code: "checks-failed", message: `Check failed: ${checks.failure.check}` });
    }
  }

  let releasedClaims = 0;
  const ready = blockers.length === 0 && checks?.ok === true;
  if (ready) {
    const identity = await resolveIdentity(workspace.worktree, options.agent);
    const claims = await claimsForIdentity(resolved.root, identity.agent, identity.workspace);
    for (const claim of claims) await removeClaim(resolved.root, claim.id);
    releasedClaims = claims.length;
    await updateWorkspace(resolved.root, workspace.id, (record) => ({
      ...record,
      readyAt: new Date().toISOString(),
      readySha: workspace.head ?? undefined,
    }));
  }

  const report: FinishReport = {
    ready,
    workspace,
    blockers,
    checks,
    releasedClaims,
    next: ready
      ? `Combine it from the primary project with: muxtra combine ${workspace.name}`
      : null,
  };

  if (options.json) printJson("finish", report);
  else printFinishReport(report);

  if (!ready) {
    throw new CliError(
      checks && !checks.ok
        ? "Workspace checks failed; it is not ready for integration."
        : "Workspace is not ready for integration.",
      checks && !checks.ok ? 1 : 2,
    );
  }
}

export function readinessBlockers(
  workspace: WorkspaceStatus,
  configuredCheckCount: number,
): FinishBlocker[] {
  const blockers: FinishBlocker[] = [];
  if (workspace.state === "missing") {
    blockers.push({ code: "workspace-missing", message: "The registered worktree is missing." });
    return blockers;
  }
  if (workspace.observedBranch !== workspace.branch) {
    blockers.push({
      code: "branch-mismatch",
      message: `Expected branch ${workspace.branch}, found ${workspace.observedBranch}.`,
    });
  }
  if (workspace.dirty) {
    blockers.push({
      code: "uncommitted-changes",
      message: "Commit or discard the workspace's uncommitted changes.",
    });
  }
  if (workspace.ahead === 0) {
    blockers.push({
      code: "no-commits",
      message: "The workspace has no commits beyond its recorded base.",
    });
  }
  if (workspace.behind > 0) {
    blockers.push({
      code: "stale-base",
      message: `The workspace is ${workspace.behind} commit(s) behind its recorded base.`,
    });
  }
  if (workspace.development?.alive) {
    blockers.push({
      code: "development-running",
      message: `Stop the development server with: muxtra stop ${workspace.name}`,
    });
  }
  if (configuredCheckCount === 0) {
    blockers.push({
      code: "checks-not-configured",
      message: "Configure at least one project check before declaring the workspace ready.",
    });
  }
  return blockers;
}

function printFinishReport(report: FinishReport): void {
  console.log(`Workspace: ${report.workspace.name}`);
  console.log(`Branch: ${report.workspace.branch}`);
  console.log(
    `Commits: ${report.workspace.ahead} ahead, ${report.workspace.behind} behind recorded base`,
  );

  if (report.ready) {
    console.log("\n✔ READY FOR INTEGRATION");
    console.log(`  checks passed at ${report.workspace.head?.slice(0, 12)}`);
    console.log(`  released ${report.releasedClaims} claim(s)`);
    if (report.next) console.log(`\nNext: ${report.next}`);
    return;
  }

  console.error("\n✖ NOT READY FOR INTEGRATION");
  for (const blocker of report.blockers) console.error(`  ${blocker.code}: ${blocker.message}`);
}
