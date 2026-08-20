import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { slugify } from "../format.js";
import { addWorktree, aheadBehindRefs, fetchOrigin, resolveBaseRef, resolveRef } from "../git.js";
import { addWorkspace, readState, type WorkspaceRecord } from "../state.js";
import { managedWorktreePath, resolveWithin } from "../paths.js";

export interface EnterOptions {
  agent: string;
  task?: string;
  displayName?: string;
  attachments?: string[];
  lane?: WorkspaceRecord["lane"];
  model?: string;
  teamId?: string;
  peerWorkspaces?: string[];
  base?: string;
  fetch?: boolean;
  allowStaleBase?: boolean;
  quiet?: boolean;
}

export async function enterCommand(
  cwd: string,
  rawName: string,
  options: EnterOptions,
): Promise<WorkspaceRecord> {
  const { root, config } = await loadConfig(cwd);
  const name = slugify(rawName);
  const agent = slugify(options.agent);
  const state = await readState(root);
  if (state.workspaces.some((workspace) => workspace.name === name)) {
    throw new CliError(`Workspace already exists: ${name}`);
  }

  if (options.fetch) {
    const fetched = await fetchOrigin(root);
    if (!fetched) console.warn("Warning: origin is not configured; skipped fetch.");
  }

  const branch = `${config.git.branch_prefix}/${agent}/${name}`;
  const canonicalBase = await resolveBaseRef(root, config.repository.default_branch);
  const baseRef = options.base ?? canonicalBase;
  const baseSha = await resolveRef(root, baseRef);
  const freshness = await aheadBehindRefs(root, canonicalBase, baseRef);
  if (freshness.behind > 0 && !options.allowStaleBase) {
    throw new CliError(
      `Base ${baseRef} is ${freshness.behind} commit(s) behind ${canonicalBase}. ` +
        "Update it or pass --allow-stale-base for an intentional stacked workspace.",
    );
  }
  const worktree = managedWorktreePath(root, config.project.name, name);
  await mkdir(path.dirname(worktree), { recursive: true });
  await addWorktree(root, worktree, branch, baseRef);

  for (const relativePath of config.runtime.copy_into_workspaces) {
    let source: string;
    let destination: string;
    try {
      source = resolveWithin(root, relativePath);
      destination = resolveWithin(worktree, relativePath);
    } catch (error) {
      throw new CliError((error as Error).message);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, errorOnExist: true });
  }

  const workspace: WorkspaceRecord = {
    id: randomUUID(),
    name,
    agent,
    ...(options.task?.trim() ? { task: options.task.trim() } : {}),
    ...(options.displayName?.trim() ? { displayName: options.displayName.trim() } : {}),
    ...(options.attachments?.length ? { attachments: options.attachments } : {}),
    ...(options.lane ? { lane: options.lane } : {}),
    ...(options.model?.trim() ? { model: options.model.trim() } : {}),
    ...(options.teamId ? { teamId: options.teamId } : {}),
    ...(options.peerWorkspaces?.length ? { peerWorkspaces: options.peerWorkspaces } : {}),
    branch,
    baseRef,
    baseSha,
    worktree,
    managed: true,
    createdAt: new Date().toISOString(),
  };
  await addWorkspace(root, workspace);

  if (!options.quiet) {
    console.log(`Created workspace: ${name}`);
    console.log(`Agent: ${agent}`);
    console.log(`Branch: ${branch}`);
    console.log(`Base: ${baseRef} (${baseSha.slice(0, 12)})`);
    if (freshness.behind > 0) {
      console.warn(
        `Warning: this workspace intentionally starts ${freshness.behind} commit(s) behind ${canonicalBase}.`,
      );
    }
    console.log(`Worktree: ${worktree}`);
    console.log("\nNext:");
    console.log(`  muxtra launch ${name}`);
    console.log(
      "\nThe launched agent is instructed to use muxtra bootstrap for dependencies and muxtra dev for the development server.",
    );
    console.log(`\nFor an app, remote agent, or unsupported client:`);
    console.log(`  muxtra instructions ${name}`);
    console.log(
      "\nUse muxtra dev instead of starting the development command directly so ports, environment variables, logs, and cleanup remain managed.",
    );
  }
  return workspace;
}
