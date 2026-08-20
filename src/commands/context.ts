import { loadConfig } from "../config.js";
import { remoteUrl } from "../git.js";
import { readGreen, readState } from "../state.js";
import { describeAge, readClaims } from "../claims.js";
import { printJson } from "../protocol.js";

export async function contextCommand(cwd: string, asJson: boolean): Promise<void> {
  const { root, config } = await loadConfig(cwd);
  const remote = await remoteUrl(root);
  const state = await readState(root);
  const claims = await readClaims(root);
  const green = await readGreen(root);
  const context = {
    project: config.project.name,
    root,
    repository: {
      remote: remote ?? null,
      defaultBranch: config.repository.default_branch,
    },
    runtime: config.runtime,
    checks: config.checks,
    gitPolicy: config.git,
    providers: config.providers,
    production: config.production,
    lastGreen: green,
    claims: claims.map((claim) => ({
      agent: claim.agent,
      workspace: claim.workspace,
      mode: claim.mode,
      paths: claim.paths,
      task: claim.task,
      ageSeconds: Math.round(claim.ageSeconds),
      idleSeconds: Math.round(claim.idleSeconds),
      expired: claim.expired,
    })),
    agentCommands: {
      declareIntent: 'muxtra claim --write "<paths>" --task "<one line>"',
      seeOtherAgents: "muxtra who",
      runChecks: "muxtra build",
      waitForAnotherAgent: "muxtra build --wait 10m",
      finish: "muxtra finish",
      combine: "muxtra combine",
      protocol: "muxtra agent-guide",
    },
    integration: state.integration ?? null,
    activeWorkspaces: state.workspaces.map((workspace) => ({
      name: workspace.name,
      agent: workspace.agent,
      task: workspace.task ?? null,
      branch: workspace.branch,
      worktree: workspace.worktree,
      baseRef: workspace.baseRef,
      baseSha: workspace.baseSha,
      readyAt: workspace.readyAt ?? null,
      readySha: workspace.readySha ?? null,
      combinedAt: workspace.combinedAt ?? null,
      integrationId: workspace.integrationId ?? null,
      development: workspace.development ?? null,
    })),
  };

  if (asJson) {
    printJson("context", context);
    return;
  }

  console.log(`# ${context.project}`);
  console.log(`Root: ${root}`);
  console.log(`Remote: ${remote ?? "not configured"}`);
  console.log(`Default branch: ${context.repository.defaultBranch}`);
  console.log(`Development: ${config.runtime.development ?? "not configured"}`);
  console.log(`Install: ${config.runtime.install ?? "not configured"}`);
  console.log(`Checks: ${config.checks.length ? config.checks.join(", ") : "none configured"}`);
  console.log(
    `Direct push to production branch: ${config.git.direct_push_to_main ? "allowed" : "forbidden"}`,
  );
  console.log(`Force push: ${config.git.force_push ? "allowed" : "forbidden"}`);
  console.log(
    `Production approval: ${config.production.requires_approval ? "required" : "not required"}`,
  );
  console.log(`Active workspaces: ${state.workspaces.length}`);

  const active = claims.filter((claim) => !claim.expired);
  if (active.length === 0) {
    console.log("Active claims: none");
  } else {
    console.log(`Active claims: ${active.length}`);
    for (const claim of active) {
      console.log(
        `  ${claim.agent}  ${claim.mode}  ${claim.paths.join(", ")}  (seen ${describeAge(claim.idleSeconds)} ago)`,
      );
    }
  }
  console.log(
    '\nBefore editing: muxtra claim --write "<paths>" --task "<one line>"\n' +
      "To check your work: muxtra build   (matches failing paths to claims; see muxtra agent-guide)",
  );
}
