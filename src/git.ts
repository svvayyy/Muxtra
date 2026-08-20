import path from "node:path";
import { CliError } from "./errors.js";
import { run } from "./process.js";

export async function gitRoot(cwd: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], cwd);
  return path.resolve(cwd, stdout);
}

export async function gitCommonDir(cwd: string): Promise<string> {
  const root = await gitRoot(cwd);
  const { stdout } = await run("git", ["rev-parse", "--git-common-dir"], cwd);
  return path.resolve(root, stdout);
}

export async function gitHead(cwd: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "HEAD"], cwd);
  return stdout;
}

export async function gitBranch(cwd: string): Promise<string> {
  const { stdout } = await run("git", ["branch", "--show-current"], cwd);
  return stdout || "(detached)";
}

export async function gitStatus(cwd: string): Promise<string> {
  const { stdout } = await run("git", ["status", "--porcelain"], cwd);
  return stdout;
}

export async function changedFiles(cwd: string, baseRef: string): Promise<string[]> {
  const { stdout } = await run("git", ["diff", "--name-only", `${baseRef}...HEAD`], cwd);
  const committed = stdout.split("\n").filter(Boolean);
  const dirty = (await gitStatus(cwd))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1) ?? line.slice(3));
  return [...new Set([...committed, ...dirty])].sort();
}

export async function resolveRef(cwd: string, ref: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", ref], cwd);
  return stdout;
}

export async function mergeBase(cwd: string, left: string, right: string): Promise<string> {
  const { stdout } = await run("git", ["merge-base", left, right], cwd);
  return stdout;
}

export async function hasRef(cwd: string, ref: string): Promise<boolean> {
  try {
    await run("git", ["rev-parse", "--verify", "--quiet", ref], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function resolveBaseRef(cwd: string, branch: string): Promise<string> {
  // A local default branch may contain committed work that has not been pushed yet.
  // New local agents must see that work, so prefer it over the remote-tracking ref.
  const candidates = [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`, branch];
  for (const candidate of candidates) {
    if (await hasRef(cwd, candidate)) {
      return candidate;
    }
  }

  if (await hasRef(cwd, "HEAD")) {
    return "HEAD";
  }

  throw new CliError("The repository has no commits. Create an initial commit first.");
}

export async function addWorktree(
  cwd: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
): Promise<void> {
  if (await hasRef(cwd, `refs/heads/${branch}`)) {
    throw new CliError(`Branch already exists: ${branch}`);
  }

  await run("git", ["worktree", "add", "-b", branch, worktreePath, baseRef], cwd);
}

export async function removeWorktree(cwd: string, worktreePath: string): Promise<void> {
  await run("git", ["worktree", "remove", worktreePath], cwd);
}

export async function forceRemoveWorktree(cwd: string, worktreePath: string): Promise<void> {
  await run("git", ["worktree", "remove", "--force", worktreePath], cwd);
}

export async function remoteUrl(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["remote", "get-url", "origin"], cwd);
    return stdout || undefined;
  } catch {
    return undefined;
  }
}

export async function fetchOrigin(cwd: string): Promise<boolean> {
  if (!(await remoteUrl(cwd))) return false;
  await run("git", ["fetch", "--prune", "origin"], cwd);
  return true;
}

export interface GitWorktree {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
}

export async function listWorktrees(cwd: string): Promise<GitWorktree[]> {
  const { stdout } = await run("git", ["worktree", "list", "--porcelain"], cwd);
  if (!stdout) return [];

  return stdout.split(/\n\n+/).map((block) => {
    const fields = new Map<string, string>();
    let detached = false;
    for (const line of block.split("\n")) {
      const separator = line.indexOf(" ");
      if (separator === -1) {
        if (line === "detached") detached = true;
        continue;
      }
      fields.set(line.slice(0, separator), line.slice(separator + 1));
    }

    return {
      path: path.resolve(fields.get("worktree") ?? ""),
      head: fields.get("HEAD") ?? "",
      branch: fields.get("branch")?.replace(/^refs\/heads\//, ""),
      detached,
    };
  });
}

export async function aheadBehind(
  cwd: string,
  baseRef: string,
): Promise<{ ahead: number; behind: number }> {
  return aheadBehindRefs(cwd, baseRef, "HEAD");
}

export async function aheadBehindRefs(
  cwd: string,
  baseRef: string,
  headRef: string,
): Promise<{ ahead: number; behind: number }> {
  const { stdout } = await run(
    "git",
    ["rev-list", "--left-right", "--count", `${baseRef}...${headRef}`],
    cwd,
  );
  const [behind, ahead] = stdout.split(/\s+/).map(Number);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}
