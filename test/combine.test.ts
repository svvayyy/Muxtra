import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(projectRoot, "dist", "cli.js");
const temporaryDirectories: string[] = [];

async function exec(command: string, args: string[], cwd: string, runtime?: string) {
  return execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(runtime ? { MUXTRA_HOME: runtime } : {}) },
  });
}

function jsonData<T>(stdout: string): T {
  return (JSON.parse(stdout) as { data: T }).data;
}

async function createRepository(combinedChecksFail = false): Promise<{
  root: string;
  runtime: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "muxtra-combine-test-"));
  const runtime = `${root}-runtime`;
  temporaryDirectories.push(root, runtime);
  await exec("git", ["init", "-b", "main"], root);
  await exec("git", ["config", "user.email", "tests@example.com"], root);
  await exec("git", ["config", "user.name", "Muxtra Tests"], root);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "combine-fixture",
      packageManager: "npm@11.0.0",
      scripts: { test: "node check.mjs" },
    }),
  );
  await writeFile(
    path.join(root, "check.mjs"),
    combinedChecksFail
      ? `import { existsSync } from "node:fs";
if (existsSync("first.txt") && existsSync("second.txt")) {
  console.error("features fail when combined");
  process.exit(1);
}
`
      : `console.log("checks passed");\n`,
  );
  await writeFile(path.join(root, "shared.txt"), "starting point\n");
  await exec("git", ["add", "."], root);
  await exec("git", ["commit", "-m", "Initial commit"], root);
  await exec(process.execPath, [cli, "setup"], root, runtime);
  return { root, runtime };
}

async function createTask(
  root: string,
  runtime: string,
  name: string,
  agent: string,
): Promise<{ name: string; branch: string; worktree: string }> {
  await exec(
    process.execPath,
    [cli, "start", `Implement ${name}`, "--name", name, "--agent", agent, "--no-launch"],
    root,
    runtime,
  );
  const status = await exec(process.execPath, [cli, "status", "--json"], root, runtime);
  const workspaces = jsonData<Array<{ name: string; branch: string; worktree: string }>>(
    status.stdout,
  );
  return workspaces.find((workspace) => workspace.name === name)!;
}

async function commitAndFinish(
  root: string,
  runtime: string,
  workspace: { name: string; worktree: string },
  file: string,
  contents: string,
): Promise<void> {
  await writeFile(path.join(workspace.worktree, file), contents);
  await exec("git", ["add", file], workspace.worktree);
  await exec("git", ["commit", "-m", `Complete ${workspace.name}`], workspace.worktree);
  await exec(process.execPath, [cli, "finish", workspace.name], root, runtime);
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("muxtra combine", () => {
  it("combines verified task branches and advances main only after checks pass", async () => {
    const { root, runtime } = await createRepository();
    const first = await createTask(root, runtime, "first-feature", "codex");
    const second = await createTask(root, runtime, "second-feature", "claude");
    await commitAndFinish(root, runtime, first, "first.txt", "from codex\n");
    await commitAndFinish(root, runtime, second, "second.txt", "from claude\n");

    const combined = await exec(process.execPath, [cli, "combine", "--json"], root, runtime);
    const report = jsonData<{
      ok: boolean;
      status: string;
      integration: { worktree: string; workspaceNames: string[] };
      appliedBranch: string;
    }>(combined.stdout);

    expect(report).toMatchObject({
      ok: true,
      status: "combined",
      appliedBranch: "main",
      integration: { workspaceNames: ["first-feature", "second-feature"] },
    });
    expect(await readFile(path.join(root, "first.txt"), "utf8")).toBe("from codex\n");
    expect(await readFile(path.join(root, "second.txt"), "utf8")).toBe("from claude\n");
    const combinedStatus = await exec(
      process.execPath,
      [cli, "combine-status", "--json"],
      root,
      runtime,
    );
    expect(jsonData(combinedStatus.stdout)).toMatchObject({
      status: "combined",
      workspaceNames: ["first-feature", "second-feature"],
    });
    await expect(access(report.integration.worktree)).rejects.toThrow();
    await expect(
      exec("git", ["show-ref", "--verify", `refs/heads/${first.branch}`], root),
    ).resolves.toBeDefined();
    await expect(
      exec("git", ["show-ref", "--verify", `refs/heads/${second.branch}`], root),
    ).resolves.toBeDefined();

    const status = await exec(process.execPath, [cli, "status", "--json"], root, runtime);
    expect(jsonData(status.stdout)).toMatchObject([
      { name: "first-feature", state: "combined" },
      { name: "second-feature", state: "combined" },
    ]);
    const humanStatus = await exec(process.execPath, [cli, "status", "--details"], root, runtime);
    expect(humanStatus.stderr).not.toContain("behind their recorded base");
  }, 15_000);

  it("refuses work that has not passed finish verification", async () => {
    const { root, runtime } = await createRepository();
    const task = await createTask(root, runtime, "unfinished", "codex");
    await writeFile(path.join(task.worktree, "unfinished.txt"), "not verified\n");
    await exec("git", ["add", "unfinished.txt"], task.worktree);
    await exec("git", ["commit", "-m", "Unverified work"], task.worktree);
    const mainBefore = (await exec("git", ["rev-parse", "HEAD"], root)).stdout.trim();

    await expect(
      exec(process.execPath, [cli, "combine", "unfinished"], root, runtime),
    ).rejects.toThrow(/has not finished verification/);
    expect((await exec("git", ["rev-parse", "HEAD"], root)).stdout.trim()).toBe(mainBefore);
  }, 15_000);

  it("combines an unchanged verified task after main advances independently", async () => {
    const { root, runtime } = await createRepository();
    const task = await createTask(root, runtime, "verified-before-main-moves", "claude");
    await commitAndFinish(root, runtime, task, "task.txt", "verified task\n");

    await writeFile(path.join(root, "main.txt"), "independent main work\n");
    await exec("git", ["add", "main.txt"], root);
    await exec("git", ["commit", "-m", "Advance main independently"], root);

    const combined = await exec(
      process.execPath,
      [cli, "combine", task.name, "--json"],
      root,
      runtime,
    );
    expect(jsonData(combined.stdout)).toMatchObject({ ok: true, status: "combined" });
    expect(await readFile(path.join(root, "main.txt"), "utf8")).toBe("independent main work\n");
    expect(await readFile(path.join(root, "task.txt"), "utf8")).toBe("verified task\n");
  }, 15_000);

  it("refuses a task commit made after finish verification", async () => {
    const { root, runtime } = await createRepository();
    const task = await createTask(root, runtime, "changed-after-finish", "codex");
    await commitAndFinish(root, runtime, task, "task.txt", "verified version\n");
    await writeFile(path.join(task.worktree, "task.txt"), "changed later\n");
    await exec("git", ["add", "task.txt"], task.worktree);
    await exec("git", ["commit", "-m", "Change task after verification"], task.worktree);
    const mainBefore = (await exec("git", ["rev-parse", "HEAD"], root)).stdout.trim();

    await expect(
      exec(process.execPath, [cli, "combine", task.name], root, runtime),
    ).rejects.toThrow(/changed after it was verified/);
    expect((await exec("git", ["rev-parse", "HEAD"], root)).stdout.trim()).toBe(mainBefore);
  }, 15_000);

  it("preserves both task branches and reports same-file conflicts", async () => {
    const { root, runtime } = await createRepository();
    const first = await createTask(root, runtime, "first-edit", "codex");
    const second = await createTask(root, runtime, "second-edit", "claude");
    await commitAndFinish(root, runtime, first, "shared.txt", "codex version\n");
    await commitAndFinish(root, runtime, second, "shared.txt", "claude version\n");
    const mainBefore = (await exec("git", ["rev-parse", "HEAD"], root)).stdout.trim();

    let failure: (Error & { stdout?: string }) | undefined;
    try {
      await exec(process.execPath, [cli, "combine", "--json"], root, runtime);
    } catch (error) {
      failure = error as Error & { stdout?: string };
    }
    expect(failure?.stdout).toBeTruthy();
    const report = jsonData<{
      ok: boolean;
      status: string;
      integration: { conflicts: string[]; worktree: string };
    }>(failure!.stdout!);
    expect(report).toMatchObject({
      ok: false,
      status: "conflict",
      integration: { conflicts: ["shared.txt"] },
    });
    expect((await exec("git", ["rev-parse", "HEAD"], root)).stdout.trim()).toBe(mainBefore);
    await expect(access(report.integration.worktree)).resolves.toBeUndefined();

    const aborted = await exec(
      process.execPath,
      [cli, "combine", "--abort", "--json"],
      root,
      runtime,
    );
    expect(jsonData(aborted.stdout)).toMatchObject({ ok: true, status: "aborted" });
    await expect(access(report.integration.worktree)).rejects.toThrow();
    await expect(
      exec("git", ["show-ref", "--verify", `refs/heads/${first.branch}`], root),
    ).resolves.toBeDefined();
    await expect(
      exec("git", ["show-ref", "--verify", `refs/heads/${second.branch}`], root),
    ).resolves.toBeDefined();
  }, 15_000);

  it("does not apply changes that fail only when they are combined", async () => {
    const { root, runtime } = await createRepository(true);
    const first = await createTask(root, runtime, "first-half", "codex");
    const second = await createTask(root, runtime, "second-half", "claude");
    await commitAndFinish(root, runtime, first, "first.txt", "passes alone\n");
    await commitAndFinish(root, runtime, second, "second.txt", "passes alone\n");
    const mainBefore = (await exec("git", ["rev-parse", "HEAD"], root)).stdout.trim();

    let failure: (Error & { stdout?: string }) | undefined;
    try {
      await exec(process.execPath, [cli, "combine", "--json"], root, runtime);
    } catch (error) {
      failure = error as Error & { stdout?: string };
    }
    const report = jsonData<{ ok: boolean; status: string; message: string }>(failure!.stdout!);
    expect(report).toMatchObject({ ok: false, status: "failed" });
    expect(report.message).toContain("failed npm run test");
    expect((await exec("git", ["rev-parse", "HEAD"], root)).stdout.trim()).toBe(mainBefore);

    await exec(process.execPath, [cli, "combine", "--abort"], root, runtime);
  }, 15_000);
});
