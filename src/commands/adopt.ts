import { realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { slugify } from "../format.js";
import {
  aheadBehind,
  gitCommonDir,
  gitStatus,
  listWorktrees,
  mergeBase,
  resolveBaseRef,
} from "../git.js";
import { addWorkspace, readState } from "../state.js";

export interface AdoptOptions {
  agent: string;
  name?: string;
  base?: string;
}

export async function adoptCommand(
  cwd: string,
  rawPath: string,
  options: AdoptOptions,
): Promise<void> {
  const { root, config } = await loadConfig(cwd);
  const target = await realpath(path.resolve(cwd, rawPath));
  const [rootCommonDir, targetCommonDir] = await Promise.all([
    realpath(await gitCommonDir(root)),
    realpath(await gitCommonDir(target)),
  ]);
  if (rootCommonDir !== targetCommonDir) {
    throw new CliError(`${target} is not a worktree of ${root}.`);
  }

  const worktrees = await listWorktrees(root);
  const worktree = worktrees.find((candidate) => candidate.path === target);
  if (!worktree) {
    throw new CliError(`${target} is not registered as a Git worktree.`);
  }
  if (!worktree.branch || worktree.detached) {
    throw new CliError("Adopted worktrees must have a branch. Create one before adopting it.");
  }
  if (worktree.branch === config.repository.default_branch) {
    throw new CliError(
      `Refusing to adopt the protected default branch ${worktree.branch} as an agent workspace.`,
    );
  }

  const state = await readState(root);
  if (state.workspaces.some((workspace) => path.resolve(workspace.worktree) === target)) {
    throw new CliError(`Worktree is already registered: ${target}`);
  }

  const inferredName = worktree.branch.split("/").at(-1) || path.basename(target);
  const name = slugify(options.name ?? inferredName);
  if (state.workspaces.some((workspace) => workspace.name === name)) {
    throw new CliError(`Workspace already exists: ${name}`);
  }

  const agent = slugify(options.agent);
  const baseRef = options.base ?? (await resolveBaseRef(root, config.repository.default_branch));
  const baseSha = await mergeBase(target, baseRef, "HEAD");
  const [delta, dirty] = await Promise.all([aheadBehind(target, baseRef), gitStatus(target)]);

  await addWorkspace(root, {
    id: randomUUID(),
    name,
    agent,
    branch: worktree.branch,
    baseRef,
    baseSha,
    worktree: target,
    managed: false,
    createdAt: new Date().toISOString(),
  });

  console.log(`Adopted workspace: ${name}`);
  console.log(`Agent: ${agent}`);
  console.log(`Branch: ${worktree.branch}`);
  console.log(`Worktree: ${target}`);
  console.log(`Compared with: ${baseRef}`);
  console.log(`Ahead: ${delta.ahead}; behind: ${delta.behind}; dirty: ${dirty.length > 0}`);
  if (delta.behind > 0) {
    console.warn(
      `Warning: ${worktree.branch} is ${delta.behind} commit(s) behind ${baseRef}. ` +
        "Do not integrate or deploy it until it has been synchronized and rechecked.",
    );
  }
}
