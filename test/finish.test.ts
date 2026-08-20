import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(projectRoot, "dist", "cli.js");
const temporaryDirectories: string[] = [];

interface ExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function exec(command: string, args: string[], cwd: string): Promise<ExecOutcome> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        MUXTRA_HOME: path.join(cwd, ".muxtra-test-runtime"),
      },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const cause = error as { code?: number; stdout?: string; stderr?: string };
    return { code: cause.code ?? 1, stdout: cause.stdout ?? "", stderr: cause.stderr ?? "" };
  }
}

const muxtra = (args: string[], cwd: string) => exec(process.execPath, [cli, ...args], cwd);

function jsonData<T>(stdout: string): T {
  const envelope = JSON.parse(stdout) as {
    schemaVersion: number;
    command: string;
    generatedAt: string;
    data: T;
  };
  expect(envelope).toMatchObject({ schemaVersion: 1, command: expect.any(String) });
  expect(Date.parse(envelope.generatedAt)).not.toBeNaN();
  return envelope.data;
}

async function createWorkspace(name = "ready-task"): Promise<{
  repository: string;
  worktree: string;
}> {
  const repository = await mkdtemp(path.join(os.tmpdir(), "muxtra-finish-test-"));
  temporaryDirectories.push(repository);
  await exec("git", ["init", "-b", "main"], repository);
  await exec("git", ["config", "user.email", "tests@example.com"], repository);
  await exec("git", ["config", "user.name", "Muxtra Tests"], repository);
  await writeFile(
    path.join(repository, "package.json"),
    JSON.stringify({ name: "example", scripts: { test: "node check.mjs" } }),
  );
  await writeFile(path.join(repository, "check.mjs"), 'console.log("checks passed");\n');
  await writeFile(path.join(repository, "feature.txt"), "base\n");
  await exec("git", ["add", "."], repository);
  await exec("git", ["commit", "-m", "Initial commit"], repository);
  await muxtra(["init"], repository);
  await exec("git", ["add", ".muxtra/project.yaml"], repository);
  await exec("git", ["commit", "-m", "Add project contract"], repository);
  const entered = await muxtra(["enter", name, "--agent", "codex"], repository);
  expect(entered.code, entered.stderr).toBe(0);

  const status = await muxtra(["status", "--json"], repository);
  expect(status.code, status.stderr).toBe(0);
  const [workspace] = jsonData<Array<{ worktree: string }>>(status.stdout);
  return { repository, worktree: workspace.worktree };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("muxtra finish", () => {
  it("blocks an uncommitted workspace before running checks", async () => {
    const { repository, worktree } = await createWorkspace("dirty-task");
    await writeFile(path.join(worktree, "feature.txt"), "unfinished\n");

    const result = await muxtra(["finish", "dirty-task", "--json"], repository);
    const report = jsonData<{
      ready: boolean;
      checks: null;
      blockers: Array<{ code: string }>;
    }>(result.stdout);

    expect(result.code).toBe(2);
    expect(report.ready).toBe(false);
    expect(report.checks).toBeNull();
    expect(report.blockers.map((blocker) => blocker.code)).toContain("uncommitted-changes");
  });

  it("runs checks, releases claims, and reports a committed workspace ready", async () => {
    const { repository, worktree } = await createWorkspace();
    await muxtra(["claim", "feature.txt", "--agent", "codex"], worktree);
    await writeFile(path.join(worktree, "feature.txt"), "finished\n");
    await exec("git", ["add", "feature.txt"], worktree);
    await exec("git", ["commit", "-m", "Finish feature"], worktree);

    const result = await muxtra(["finish", "ready-task", "--json"], repository);
    const report = jsonData<{
      ready: boolean;
      releasedClaims: number;
      checks: { ok: boolean; green: { sha: string } };
      workspace: { ahead: number; dirty: boolean };
    }>(result.stdout);

    expect(result.code).toBe(0);
    expect(report).toMatchObject({
      ready: true,
      releasedClaims: 1,
      checks: { ok: true },
      workspace: { ahead: 1, dirty: false },
    });
    expect(report.checks.green.sha).toMatch(/^[0-9a-f]{40}$/);

    const status = await muxtra(["status", "--json"], repository);
    const [workspace] = jsonData<Array<{ readyAt?: string; readySha?: string }>>(status.stdout);
    expect(workspace.readySha).toBe(report.checks.green.sha);
    expect(Date.parse(workspace.readyAt!)).not.toBeNaN();

    const claims = await muxtra(["who", "--json"], worktree);
    expect(jsonData<{ claims: unknown[] }>(claims.stdout).claims).toEqual([]);
  }, 10_000);

  it("returns the failing check in a machine-readable readiness report", async () => {
    const { repository, worktree } = await createWorkspace("broken-task");
    await writeFile(path.join(worktree, "check.mjs"), "process.exitCode = 1;\n");
    await writeFile(path.join(worktree, "feature.txt"), "broken\n");
    await exec("git", ["add", "check.mjs", "feature.txt"], worktree);
    await exec("git", ["commit", "-m", "Add broken feature"], worktree);

    const result = await muxtra(["finish", "broken-task", "--json"], repository);
    const report = jsonData<{
      ready: boolean;
      checks: { ok: boolean; failure: { check: string } };
      blockers: Array<{ code: string }>;
    }>(result.stdout);

    expect(result.code).toBe(1);
    expect(report.ready).toBe(false);
    expect(report.checks).toMatchObject({ ok: false, failure: { check: "npm run test" } });
    expect(report.blockers.map((blocker) => blocker.code)).toContain("checks-failed");
  });
});
