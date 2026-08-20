import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { slugify } from "./format.js";

export function muxtraHome(): string {
  const configuredHome = process.env.MUXTRA_HOME ?? process.env.PARALLEL_AGENT_HOME;
  return configuredHome ? path.resolve(configuredHome) : path.join(os.homedir(), ".muxtra");
}

export async function pathsReferToSameLocation(left: string, right: string): Promise<boolean> {
  const canonical = async (value: string) => {
    try {
      return await realpath(value);
    } catch {
      return path.resolve(value);
    }
  };
  return (await canonical(left)) === (await canonical(right));
}

export function resolveWithin(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Expected a non-empty relative path: ${relativePath}`);
  }
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes its repository: ${relativePath}`);
  }
  return resolved;
}

export function managedWorktreePath(
  repositoryRoot: string,
  projectName: string,
  workspaceName: string,
): string {
  const repositoryId = createHash("sha256")
    .update(path.resolve(repositoryRoot))
    .digest("hex")
    .slice(0, 10);
  const repositoryDirectory = `${slugify(projectName)}-${repositoryId}`;
  return path.join(muxtraHome(), "worktrees", repositoryDirectory, workspaceName);
}

export function workspaceLogPath(
  repositoryRoot: string,
  projectName: string,
  workspaceName: string,
): string {
  const repositoryId = createHash("sha256")
    .update(path.resolve(repositoryRoot))
    .digest("hex")
    .slice(0, 10);
  const repositoryDirectory = `${slugify(projectName)}-${repositoryId}`;
  return path.join(muxtraHome(), "logs", repositoryDirectory, `${workspaceName}.log`);
}
