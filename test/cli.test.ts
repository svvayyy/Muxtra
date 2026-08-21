import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { findVercelProjectLink, prepareVercelProjectLink } from "../src/runtime.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(projectRoot, "dist", "cli.js");
const temporaryDirectories: string[] = [];

function jsonData<T>(stdout: string): T {
  const envelope = JSON.parse(stdout) as {
    schemaVersion: number;
    command: string;
    data: T;
  };
  expect(envelope.schemaVersion).toBe(1);
  expect(envelope.command).toBeTruthy();
  return envelope.data;
}

async function exec(
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
) {
  return execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      MUXTRA_HOME: path.join(cwd, ".muxtra-test-runtime"),
      ...environment,
    },
  });
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "parallel-agent-test-"));
  temporaryDirectories.push(root);
  await exec("git", ["init", "-b", "main"], root);
  await exec("git", ["config", "user.email", "tests@example.com"], root);
  await exec("git", ["config", "user.name", "Muxtra Tests"], root);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "example",
      packageManager: "pnpm@10.20.0",
      scripts: { dev: "node server.mjs", test: "vitest run", build: "vite build" },
    }),
  );
  await writeFile(
    path.join(root, "server.mjs"),
    `import http from "node:http";
const port = Number(process.env.PORT);
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("parallel agent test server");
});
server.listen(port, "127.0.0.1", () => console.log(\`ready on \${port}\`));
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`,
  );
  await writeFile(path.join(root, "README.md"), "# Example\n");
  await exec("git", ["add", "."], root);
  await exec("git", ["commit", "-m", "Initial commit"], root);
  return root;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Muxtra", () => {
  it("uses the start argument as tracking metadata instead of an agent prompt", async () => {
    const repository = await createRepository();
    const setup = await exec(process.execPath, [cli, "setup"], repository);

    expect(setup.stdout).toContain("Muxtra is ready");
    expect(setup.stdout).toContain('Committed .muxtra/project.yaml as "Configure Muxtra"');
    expect(await readFile(path.join(repository, ".muxtra", "project.yaml"), "utf8")).toContain(
      "default_branch: main",
    );
    const setupCommit = await exec("git", ["log", "-1", "--pretty=%s"], repository);
    expect(setupCommit.stdout.trim()).toBe("Configure Muxtra");

    const started = await exec(
      process.execPath,
      [cli, "start", "Polish the dashboard navigation", "--agent", "codex", "--no-launch"],
      repository,
    );
    expect(started.stdout).toContain("Task: Polish the dashboard navigation");
    expect(started.stdout).toContain("Workspace: polish-the-dashboard-navigation");

    const launchPreview = await exec(
      process.execPath,
      [cli, "launch", "polish-the-dashboard-navigation", "--dry-run"],
      repository,
    );
    expect(launchPreview.stdout).not.toContain("User task:");
    expect(launchPreview.stdout).toContain("ask the user what they want to work on");
    expect(launchPreview.stdout).toContain("workspace title is tracking metadata");

    const status = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(status.stdout)).toMatchObject([
      {
        name: "polish-the-dashboard-navigation",
        agent: "codex",
        task: "Polish the dashboard navigation",
        state: "clean",
      },
    ]);

    const friendlyStatus = await exec(process.execPath, [cli, "status"], repository);
    expect(friendlyStatus.stdout).toContain("TASK");
    expect(friendlyStatus.stdout).toContain("Polish the dashboard navigation");
    expect(friendlyStatus.stdout).toContain("ready to start");
    expect(friendlyStatus.stdout).not.toContain("agent/codex/");
  });

  it("rejects an initial prompt when start is not launching the agent", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "setup"], repository);

    await expect(
      exec(
        process.execPath,
        [
          cli,
          "start",
          "Dashboard navigation",
          "--agent",
          "codex",
          "--prompt",
          "Implement the responsive navigation from the design system.",
          "--no-launch",
        ],
        repository,
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("cannot be combined with --no-launch"),
    });

    const status = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(status.stdout)).toEqual([]);
  });

  it("keeps beginner setup on the repository's primary branch", async () => {
    const repository = await createRepository();
    await exec("git", ["switch", "-c", "feature/setup-test"], repository);

    await expect(exec(process.execPath, [cli, "setup"], repository)).rejects.toMatchObject({
      stderr: expect.stringContaining("Run Muxtra setup from the primary branch (main)"),
    });
    await expect(access(path.join(repository, ".muxtra", "project.yaml"))).rejects.toThrow();
  });

  it("does not call a project ready or start work until checks are configured", async () => {
    const repository = await createRepository();
    await writeFile(
      path.join(repository, "package.json"),
      JSON.stringify({ name: "example", packageManager: "pnpm@10.20.0", scripts: {} }),
    );
    await exec("git", ["add", "package.json"], repository);
    await exec("git", ["commit", "-m", "Remove project checks"], repository);

    const setup = await exec(process.execPath, [cli, "setup"], repository);
    expect(setup.stdout).not.toContain("Muxtra is ready");
    expect(setup.stderr).toContain("Muxtra needs at least one project check");

    await expect(
      exec(
        process.execPath,
        [cli, "start", "Build the dashboard", "--agent", "codex", "--no-launch"],
        repository,
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("No project checks are configured"),
    });
  });

  it("directs unconfigured projects to the beginner setup command", async () => {
    const repository = await createRepository();
    await expect(
      exec(
        process.execPath,
        [cli, "start", "Build the dashboard", "--agent", "codex", "--no-launch"],
        repository,
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('Run "muxtra setup" first'),
    });
  });

  it("shows the core workflow first in top-level help", async () => {
    const help = await exec(process.execPath, [cli, "--help"], projectRoot);
    const orderedCommands = ["setup", "agents", "start", "status", "finish", "combine"];
    const positions = orderedCommands.map((command) => help.stdout.indexOf(`  ${command}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("routes design and code tasks to locally configured models", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "setup"], repository);

    await exec(
      process.execPath,
      [cli, "lanes", "set", "design", "--agent", "claude", "--model", "design-model"],
      repository,
    );
    await exec(
      process.execPath,
      [cli, "lanes", "set", "code", "--agent", "codex", "--model", "code-model"],
      repository,
    );
    const lanes = await exec(process.execPath, [cli, "lanes"], repository);
    expect(lanes.stdout).toContain("design-model");
    expect(lanes.stdout).toContain("code-model");
    const laneProtocol = await exec(process.execPath, [cli, "lanes", "--json"], repository);
    expect(jsonData(laneProtocol.stdout)).toMatchObject({
      lanes: [
        { lane: "design", agent: "claude", model: "design-model", source: "local" },
        { lane: "code", agent: "codex", model: "code-model", source: "local" },
      ],
    });
    expect((await exec("git", ["status", "--porcelain"], repository)).stdout).toBe("");

    await exec(
      process.execPath,
      [cli, "start", "Polish account settings", "--lane", "design", "--no-launch"],
      repository,
    );
    const status = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(status.stdout)).toMatchObject([
      {
        lane: "design",
        agent: "claude",
        model: "design-model",
        name: "polish-account-settings-design",
      },
    ]);
    const preview = await exec(
      process.execPath,
      [cli, "launch", "polish-account-settings-design", "--dry-run"],
      repository,
    );
    expect(preview.stdout).toContain("Model: design-model");
    expect(preview.stdout).toContain("Own the UI, frontend behavior");
  });

  it("creates a coordinated design and code team without launching either TUI inline", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "setup"], repository);
    await exec(
      process.execPath,
      [cli, "lanes", "set", "design", "--agent", "claude", "--model", "design-model"],
      repository,
    );
    await exec(
      process.execPath,
      [cli, "lanes", "set", "code", "--agent", "codex", "--model", "code-model"],
      repository,
    );

    const team = await exec(process.execPath, [cli, "team", "Build account settings"], repository);
    expect(team.stdout).toContain("Design + code team ready");
    expect(team.stdout).toContain("muxtra launch build-account-settings-design");
    expect(team.stdout).toContain("muxtra launch build-account-settings-code");

    const status = await exec(process.execPath, [cli, "status", "--json"], repository);
    const workspaces = jsonData<
      Array<{
        lane: string;
        model: string;
        teamId: string;
        peerWorkspaces: string[];
        agentActivity: unknown;
      }>
    >(status.stdout);
    expect(workspaces).toHaveLength(2);
    expect(workspaces.map((workspace) => workspace.lane).sort()).toEqual(["code", "design"]);
    expect(new Set(workspaces.map((workspace) => workspace.teamId)).size).toBe(1);
    expect(workspaces.every((workspace) => workspace.agentActivity === null)).toBe(true);
    expect(workspaces[0].peerWorkspaces).toHaveLength(1);
    expect(workspaces[1].peerWorkspaces).toHaveLength(1);

    for (const workspace of ["build-account-settings-design", "build-account-settings-code"]) {
      const preview = await exec(
        process.execPath,
        [cli, "launch", workspace, "--dry-run"],
        repository,
      );
      expect(preview.stdout).not.toContain("User task:");
      expect(preview.stdout).toContain("workspace title is tracking metadata");
    }
  });

  it("updates the npm installation from the beta channel outside a Git project", async () => {
    const fakeBin = await mkdtemp(path.join(os.tmpdir(), "muxtra-update-test-"));
    temporaryDirectories.push(fakeBin);
    const npmExecutable = path.join(fakeBin, process.platform === "win32" ? "npm.cmd" : "npm");
    const executableBody =
      process.platform === "win32"
        ? "@echo off\r\necho %*\r\n"
        : '#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join(" "));\n';
    await writeFile(npmExecutable, executableBody);
    if (process.platform !== "win32") await chmod(npmExecutable, 0o755);

    const result = await exec(process.execPath, [cli, "update"], fakeBin, {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    expect(result.stdout).toContain("Updating Muxtra from the npm beta channel");
    expect(result.stdout).toContain("install --global muxtra@beta");
    expect(result.stdout).toContain("Muxtra update complete");
  });

  it("keeps image attachments with the task and hands them to the agent", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "setup"], repository);
    const referenceDirectory = await mkdtemp(path.join(os.tmpdir(), "muxtra-image-test-"));
    temporaryDirectories.push(referenceDirectory);
    const reference = path.join(referenceDirectory, "reference.png");
    await writeFile(reference, "fixture image bytes");

    await exec(
      process.execPath,
      [
        cli,
        "start",
        "Match the attached reference",
        "--agent",
        "codex",
        "--image",
        reference,
        "--no-launch",
      ],
      repository,
    );

    const status = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(status.stdout)).toMatchObject([
      {
        name: "match-the-attached-reference",
        attachments: [reference],
      },
    ]);
    const launchPreview = await exec(
      process.execPath,
      [cli, "launch", "match-the-attached-reference", "--dry-run"],
      repository,
    );
    expect(launchPreview.stdout).toContain(reference);
  });

  it("tracks an externally opened Codex or Claude session without reading its chat", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "setup"], repository);
    await exec(
      process.execPath,
      [cli, "start", "Update the empty state", "--agent", "claude", "--no-launch"],
      repository,
    );

    const before = await exec(process.execPath, [cli, "status", "--json"], repository);
    const [workspace] = jsonData<Array<{ name: string; worktree: string }>>(before.stdout);
    const attached = await exec(
      process.execPath,
      [cli, "attach", "--agent", "claude", "--json"],
      workspace.worktree,
    );
    expect(
      jsonData<{ agent: string; activity: { source: string; status: string } }>(attached.stdout),
    ).toMatchObject({ agent: "claude", activity: { source: "attached", status: "active" } });

    const after = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(after.stdout)).toMatchObject([
      {
        name: workspace.name,
        state: "working",
        agentActivity: {
          agent: "claude",
          source: "attached",
          observedState: "active",
        },
      },
    ]);
    const friendly = await exec(process.execPath, [cli, "status"], repository);
    expect(friendly.stdout).toContain("agent active");
  });

  it("records the lifecycle of a Muxtra-managed CLI launch", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "setup"], repository);
    await exec(
      process.execPath,
      [cli, "start", "Add a keyboard shortcut", "--agent", "codex", "--no-launch"],
      repository,
    );

    const bin = path.join(repository, "test-bin");
    await mkdir(bin);
    const fakeCodex = path.join(bin, "codex");
    await writeFile(fakeCodex, "#!/bin/sh\nexit 0\n");
    await chmod(fakeCodex, 0o755);
    await exec(process.execPath, [cli, "launch", "add-a-keyboard-shortcut"], repository, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });

    const status = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(status.stdout)).toMatchObject([
      {
        name: "add-a-keyboard-shortcut",
        agentActivity: {
          agent: "codex",
          source: "managed",
          status: "exited",
          observedState: "exited",
          exitCode: 0,
        },
      },
    ]);
  });

  it("shows a live Claude process as idle after its turn completes", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "setup"], repository);
    await exec(
      process.execPath,
      [cli, "start", "Review the empty state", "--agent", "claude", "--no-launch"],
      repository,
    );

    const bin = path.join(repository, "test-bin");
    await mkdir(bin);
    const fakeClaude = path.join(bin, "claude");
    await writeFile(
      fakeClaude,
      "#!/bin/sh\nwhile [ ! -f .muxtra-test-complete ]; do sleep 0.05; done\n",
    );
    await chmod(fakeClaude, 0o755);
    const environment = {
      ...process.env,
      MUXTRA_HOME: path.join(repository, ".muxtra-test-runtime"),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    const launched = spawn(process.execPath, [cli, "launch", "review-the-empty-state"], {
      cwd: repository,
      env: environment,
      stdio: "ignore",
    });
    const completed = once(launched, "close");

    let activity: { sessionId: string; observedState: string } | undefined;
    let worktree = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = await exec(process.execPath, [cli, "status", "--json"], repository);
      const [workspace] = jsonData<
        Array<{
          worktree: string;
          agentActivity?: { sessionId: string; observedState: string };
        }>
      >(status.stdout);
      worktree = workspace.worktree;
      if (workspace.agentActivity?.observedState === "running") {
        activity = workspace.agentActivity;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(activity).toBeDefined();

    await exec(process.execPath, [cli, "agent-status", "--state", "waiting"], worktree, {
      ...environment,
      MUXTRA_WORKSPACE: "review-the-empty-state",
      MUXTRA_SESSION_ID: activity!.sessionId,
    });
    const waiting = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(waiting.stdout)).toMatchObject([
      { agentActivity: { phase: "waiting", observedState: "waiting", alive: true } },
    ]);

    await exec(process.execPath, [cli, "agent-status", "--state", "working"], worktree, {
      ...environment,
      MUXTRA_WORKSPACE: "review-the-empty-state",
      MUXTRA_SESSION_ID: activity!.sessionId,
    });
    const resumed = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(resumed.stdout)).toMatchObject([
      { agentActivity: { phase: "working", observedState: "running", alive: true } },
    ]);

    await writeFile(path.join(worktree, ".muxtra-test-complete"), "done\n");
    await completed;
  });

  it("does not hide local project changes from a newly started agent", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "setup"], repository);
    await writeFile(path.join(repository, "local-change.txt"), "not committed\n");

    await expect(
      exec(
        process.execPath,
        [cli, "start", "Work from the latest project", "--agent", "codex", "--no-launch"],
        repository,
      ),
    ).rejects.toThrow(/local changes that new agents cannot see/);

    const status = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(status.stdout)).toEqual([]);
  });

  it("starts agents from committed local work that has not been pushed yet", async () => {
    const repository = await createRepository();
    const remote = await mkdtemp(path.join(os.tmpdir(), "muxtra-origin-test-"));
    temporaryDirectories.push(remote);
    await exec("git", ["init", "--bare"], remote);
    await exec("git", ["remote", "add", "origin", remote], repository);
    await exec("git", ["push", "-u", "origin", "main"], repository);

    await exec(process.execPath, [cli, "setup"], repository);
    const localHead = (await exec("git", ["rev-parse", "HEAD"], repository)).stdout.trim();
    const remoteHead = (await exec("git", ["rev-parse", "origin/main"], repository)).stdout.trim();
    expect(localHead).not.toBe(remoteHead);

    await exec(
      process.execPath,
      [cli, "start", "Use the newest local code", "--agent", "claude", "--no-launch"],
      repository,
    );
    const status = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(status.stdout)).toMatchObject([{ baseSha: localHead, head: localHead }]);
  });

  it("initializes a portable project contract", async () => {
    const repository = await createRepository();
    const result = await exec(process.execPath, [cli, "init"], repository);

    expect(result.stdout).toContain("Initialized Muxtra");
    expect(await readFile(path.join(repository, ".muxtra", "project.yaml"), "utf8")).toContain(
      "default_branch: main",
    );
    await expect(access(path.join(repository, "AGENTS.md"))).rejects.toThrow();
  });

  it("installs agent instructions only when explicitly requested", async () => {
    const repository = await createRepository();
    const result = await exec(process.execPath, [cli, "init", "--install-guide"], repository);

    expect(result.stdout).toContain("Created AGENTS.md");
    const guide = await readFile(path.join(repository, "AGENTS.md"), "utf8");
    expect(guide).toContain("<!-- muxtra:begin -->");
    expect(guide).toContain('muxtra claim --write "<paths you will edit>"');

    await expect(
      exec(process.execPath, [cli, "install-guide", "--file", "../outside.md"], repository),
    ).rejects.toThrow(/Expected a non-empty relative path|Path escapes its repository/);
  });

  it("rejects workspace copy paths outside the repository", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "init"], repository);
    const configPath = path.join(repository, ".muxtra", "project.yaml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace("copy_into_workspaces: []", "copy_into_workspaces:\n  - ../private.env"),
    );

    await expect(exec(process.execPath, [cli, "context", "--json"], repository)).rejects.toThrow(
      /must be a relative path that stays inside the repository/,
    );
  });

  it("creates and reports an isolated agent workspace", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "init"], repository);
    await exec("git", ["add", "."], repository);
    await exec("git", ["commit", "-m", "Add project contract"], repository);

    const entered = await exec(
      process.execPath,
      [cli, "enter", "dashboard polish", "--agent", "codex"],
      repository,
    );
    expect(entered.stdout).toContain("agent/codex/dashboard-polish");
    expect(entered.stdout).toContain("muxtra launch dashboard-polish");
    expect(entered.stdout).toContain("Use muxtra dev instead of starting");

    const status = await exec(process.execPath, [cli, "status", "--json"], repository);
    const workspaces = jsonData<
      Array<{
        name: string;
        agent: string;
        branch: string;
        state: string;
        worktree: string;
      }>
    >(status.stdout);
    expect(workspaces).toMatchObject([
      {
        name: "dashboard-polish",
        agent: "codex",
        branch: "agent/codex/dashboard-polish",
        state: "clean",
      },
    ]);

    const claimed = await exec(
      process.execPath,
      [cli, "claim", "src/**", "--agent", "claude", "--json"],
      workspaces[0].worktree,
    );
    expect(
      jsonData<{ claim: { agent: string; workspace: string } }>(claimed.stdout).claim,
    ).toMatchObject({
      agent: "claude",
      workspace: "dashboard-polish",
    });
  });

  it("removes a clean managed worktree while retaining its branch", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "init"], repository);
    await exec("git", ["add", "."], repository);
    await exec("git", ["commit", "-m", "Add project contract"], repository);
    await exec(process.execPath, [cli, "enter", "finished-task", "--agent", "codex"], repository);

    const before = await exec(process.execPath, [cli, "status", "--json"], repository);
    const [workspace] = jsonData<
      Array<{
        worktree: string;
        branch: string;
      }>
    >(before.stdout);
    const removed = await exec(process.execPath, [cli, "remove", "finished-task"], repository);

    expect(removed.stdout).toContain("Removed workspace: finished-task");
    expect(removed.stdout).toContain(`Branch retained: ${workspace.branch}`);
    await expect(access(workspace.worktree)).rejects.toThrow();
    await expect(
      exec("git", ["show-ref", "--verify", `refs/heads/${workspace.branch}`], repository),
    ).resolves.toBeDefined();
    const after = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(after.stdout)).toEqual([]);
  });

  it("refuses to remove a managed worktree with uncommitted changes", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "init"], repository);
    await exec("git", ["add", "."], repository);
    await exec("git", ["commit", "-m", "Add project contract"], repository);
    await exec(process.execPath, [cli, "enter", "active-task", "--agent", "claude"], repository);
    const before = await exec(process.execPath, [cli, "status", "--json"], repository);
    const [workspace] = jsonData<Array<{ worktree: string }>>(before.stdout);
    await writeFile(path.join(workspace.worktree, "unfinished.txt"), "unfinished\n");

    await expect(
      exec(process.execPath, [cli, "remove", "active-task"], repository),
    ).rejects.toThrow(/has uncommitted changes and was not removed/);
    await expect(access(workspace.worktree)).resolves.toBeUndefined();
    const after = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(after.stdout)).toMatchObject([{ name: "active-task", state: "working" }]);
  });

  it("refuses to remove a workspace while its agent is running", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "init"], repository);
    await exec("git", ["add", "."], repository);
    await exec("git", ["commit", "-m", "Add project contract"], repository);
    await exec(process.execPath, [cli, "enter", "running-task", "--agent", "codex"], repository);

    const bin = path.join(repository, "test-bin");
    await mkdir(bin);
    const fakeCodex = path.join(bin, "codex");
    await writeFile(fakeCodex, "#!/bin/sh\nsleep 2\n");
    await chmod(fakeCodex, 0o755);
    const launched = spawn(process.execPath, [cli, "launch", "running-task"], {
      cwd: repository,
      env: {
        ...process.env,
        MUXTRA_HOME: path.join(repository, ".muxtra-test-runtime"),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      stdio: "ignore",
    });
    const completed = once(launched, "close");

    try {
      let becameRunning = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const status = await exec(process.execPath, [cli, "status", "--json"], repository);
        const [workspace] = jsonData<Array<{ agentActivity?: { observedState: string } }>>(
          status.stdout,
        );
        if (workspace.agentActivity?.observedState === "running") {
          becameRunning = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(becameRunning).toBe(true);
      await expect(
        exec(process.execPath, [cli, "launch", "running-task"], repository, {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        }),
      ).rejects.toThrow(/already running in workspace running-task/);
      await expect(
        exec(process.execPath, [cli, "remove", "running-task"], repository),
      ).rejects.toThrow(/still has a running agent/);
    } finally {
      await completed;
    }
  });

  it("adopts an existing worktree without modifying it", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "init"], repository);
    await exec("git", ["add", "."], repository);
    await exec("git", ["commit", "-m", "Add project contract"], repository);
    const existing = `${repository}-existing-stripe-worktree`;
    temporaryDirectories.push(existing);
    await exec(
      "git",
      ["worktree", "add", "-b", "feat/stripe-billing", existing, "main"],
      repository,
    );

    const before = await exec("git", ["rev-parse", "HEAD"], existing);
    const adopted = await exec(
      process.execPath,
      [cli, "adopt", existing, "--agent", "openclaw"],
      repository,
    );
    const after = await exec("git", ["rev-parse", "HEAD"], existing);

    expect(adopted.stdout).toContain("Adopted workspace: stripe-billing");
    expect(after.stdout).toBe(before.stdout);
    const status = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(status.stdout)).toMatchObject([
      {
        name: "stripe-billing",
        agent: "openclaw",
        branch: "feat/stripe-billing",
        state: "clean",
      },
    ]);

    const removed = await exec(process.execPath, [cli, "remove", "stripe-billing"], repository);
    expect(removed.stdout).toContain("Unregistered adopted workspace: stripe-billing");
    await expect(access(existing)).resolves.toBeUndefined();
    const afterRemoval = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(afterRemoval.stdout)).toEqual([]);
  });

  it("marks a workspace stale when its base branch advances", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "init"], repository);
    await exec("git", ["add", "."], repository);
    await exec("git", ["commit", "-m", "Add project contract"], repository);
    await exec(process.execPath, [cli, "enter", "long-running", "--agent", "codex"], repository);

    await writeFile(path.join(repository, "new-main-work.txt"), "new work\n");
    await exec("git", ["add", "new-main-work.txt"], repository);
    await exec("git", ["commit", "-m", "Advance main"], repository);

    const status = await exec(process.execPath, [cli, "status", "--json"], repository);
    expect(jsonData(status.stdout)).toMatchObject([
      {
        name: "long-running",
        state: "stale",
        behind: 1,
      },
    ]);
  });

  it("blocks a new workspace from silently starting on a stale base", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "init"], repository);
    await exec("git", ["add", "."], repository);
    await exec("git", ["commit", "-m", "Add project contract"], repository);
    await exec("git", ["branch", "old-base"], repository);
    await writeFile(path.join(repository, "advance.txt"), "advance\n");
    await exec("git", ["add", "advance.txt"], repository);
    await exec("git", ["commit", "-m", "Advance main"], repository);

    await expect(
      exec(
        process.execPath,
        [cli, "enter", "stale-task", "--agent", "claude", "--base", "old-base"],
        repository,
      ),
    ).rejects.toThrow(/is 1 commit\(s\) behind/);
  });

  it("starts, reports, logs, and stops an isolated development server", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "init"], repository);
    const configPath = path.join(repository, ".muxtra", "project.yaml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace("development: pnpm dev", "development: node server.mjs"),
    );
    await exec("git", ["add", "."], repository);
    await exec("git", ["commit", "-m", "Add project contract"], repository);
    await exec(process.execPath, [cli, "enter", "local-server", "--agent", "codex"], repository);

    let started = false;
    try {
      const dev = await exec(process.execPath, [cli, "dev", "local-server"], repository);
      started = true;
      expect(dev.stdout).toContain("Started development server for local-server");

      const statusResult = await exec(process.execPath, [cli, "status", "--json"], repository);
      const [workspace] = jsonData<
        Array<{
          development: { alive: boolean; observedState: string; url: string; port: number };
        }>
      >(statusResult.stdout);
      expect(workspace.development.alive).toBe(true);
      expect(workspace.development.observedState).toBe("running");
      expect(workspace.development.port).toBeGreaterThan(0);
      expect(workspace.development.url).toMatch(/^http:\/\/localhost:/);
      expect(await (await fetch(workspace.development.url)).text()).toBe(
        "parallel agent test server",
      );

      await expect(
        exec(process.execPath, [cli, "remove", "local-server"], repository),
      ).rejects.toThrow(/still has a running development process/);

      const logs = await exec(
        process.execPath,
        [cli, "logs", "local-server", "--lines", "20"],
        repository,
      );
      expect(logs.stdout).toContain("ready on");

      const stopped = await exec(process.execPath, [cli, "stop", "local-server"], repository);
      started = false;
      expect(stopped.stdout).toContain("Stopped development server");

      const afterStop = await exec(process.execPath, [cli, "status", "--json"], repository);
      expect(jsonData(afterStop.stdout)).toMatchObject([
        { development: { alive: false, observedState: "stopped" } },
      ]);

      const worktreeStatus = await exec("git", ["status", "--porcelain"], workspace.worktree);
      expect(worktreeStatus.stdout, worktreeStatus.stdout).toBe("");

      const removed = await exec(process.execPath, [cli, "remove", "local-server"], repository);
      expect(removed.stdout).toContain("Removed workspace: local-server");
    } finally {
      if (started) {
        await exec(process.execPath, [cli, "stop", "local-server", "--force"], repository).catch(
          () => undefined,
        );
      }
    }
  });

  it("prints machine-readable project context", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "init"], repository);

    const result = await exec(process.execPath, [cli, "context", "--json"], repository);
    const context = jsonData<{
      project: string;
      repository: { defaultBranch: string };
      gitPolicy: { direct_push_to_main: boolean };
    }>(result.stdout);
    expect(context.project).toBe(path.basename(repository));
    expect(context.repository.defaultBranch).toBe("main");
    expect(context.gitPolicy.direct_push_to_main).toBe(false);
  });

  it("previews an agent launch with the managed runtime instructions", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "init"], repository);
    await exec("git", ["add", "."], repository);
    await exec("git", ["commit", "-m", "Add project contract"], repository);
    await exec(process.execPath, [cli, "enter", "launch-test", "--agent", "codex"], repository);

    const preview = await exec(
      process.execPath,
      [cli, "launch", "launch-test", "--prompt", "Polish the dashboard navigation", "--dry-run"],
      repository,
    );

    expect(preview.stdout).toContain("Agent: codex");
    expect(preview.stdout).toContain("Executable: codex");
    expect(preview.stdout).toContain('Start the project with "muxtra dev"');
    expect(preview.stdout).toContain("User task:\nPolish the dashboard navigation");
  });

  it("finds the primary Vercel link when dev is invoked inside a worktree", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "init"], repository);
    await exec("git", ["add", "."], repository);
    await exec("git", ["commit", "-m", "Add project contract"], repository);
    await exec(process.execPath, [cli, "enter", "vercel-dev", "--agent", "codex"], repository);
    const status = await exec(process.execPath, [cli, "status", "--json"], repository);
    const [workspace] = jsonData<Array<{ worktree: string }>>(status.stdout);
    const primaryLink = path.join(repository, ".vercel", "project.json");
    const workspaceLink = path.join(workspace.worktree, ".vercel", "project.json");
    const project = { orgId: "team_example", projectId: "project_example" };
    await mkdir(path.dirname(primaryLink), { recursive: true });
    await writeFile(primaryLink, JSON.stringify(project));

    const location = await findVercelProjectLink(workspace.worktree);
    expect(location?.source).toBe("primary");
    expect(await realpath(location!.root)).toBe(await realpath(repository));
    expect(await realpath(location!.path)).toBe(await realpath(primaryLink));
    await prepareVercelProjectLink(workspace.worktree, workspace.worktree);
    expect(JSON.parse(await readFile(workspaceLink, "utf8"))).toEqual(project);
  });

  it("prints portable instructions for clients it cannot launch", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "init"], repository);
    await exec("git", ["add", "."], repository);
    await exec("git", ["commit", "-m", "Add project contract"], repository);
    await exec(process.execPath, [cli, "enter", "remote-agent", "--agent", "openclaw"], repository);

    const instructions = await exec(
      process.execPath,
      [cli, "instructions", "remote-agent", "--agent", "chatgpt"],
      repository,
    );

    expect(instructions.stdout).toContain("You are the chatgpt agent");
    expect(instructions.stdout).toContain("Work only in the workspace path above");
    expect(instructions.stdout).toContain("muxtra bootstrap --apply");
    expect(instructions.stdout).toContain("muxtra stop remote-agent");
    expect(instructions.stdout).toContain("live agent-session status is currently available only");
    expect(instructions.stdout).not.toContain("muxtra attach remote-agent --agent chatgpt");
  });

  it("refreshes active claim leases without reviving expired claims", async () => {
    const repository = await createRepository();
    await exec(process.execPath, [cli, "init"], repository);
    await exec("git", ["add", "."], repository);
    await exec("git", ["commit", "-m", "Add project contract"], repository);
    await exec(process.execPath, [cli, "enter", "lease-test", "--agent", "codex"], repository);
    const status = await exec(process.execPath, [cli, "status", "--json"], repository);
    const [workspace] = jsonData<Array<{ worktree: string }>>(status.stdout);
    const agentEnvironment = {
      MUXTRA_AGENT: "codex",
      MUXTRA_WORKSPACE: "lease-test",
    };

    await exec(
      process.execPath,
      [cli, "claim", "src/**", "--write", "--ttl", "0.01"],
      workspace.worktree,
      agentEnvironment,
    );
    const before = await exec(
      process.execPath,
      [cli, "who", "--json"],
      workspace.worktree,
      agentEnvironment,
    );
    const [beforeClaim] = jsonData<{ claims: Array<{ heartbeatAt: string }> }>(
      before.stdout,
    ).claims;

    await new Promise((resolve) => setTimeout(resolve, 50));
    const refreshed = await exec(
      process.execPath,
      [cli, "who", "--json"],
      workspace.worktree,
      agentEnvironment,
    );
    const [refreshedClaim] = jsonData<{
      claims: Array<{ heartbeatAt: string; expired: boolean }>;
    }>(refreshed.stdout).claims;
    expect(Date.parse(refreshedClaim.heartbeatAt)).toBeGreaterThan(
      Date.parse(beforeClaim.heartbeatAt),
    );
    expect(refreshedClaim.expired).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 700));
    const expired = await exec(
      process.execPath,
      [cli, "who", "--json"],
      workspace.worktree,
      agentEnvironment,
    );
    const [expiredClaim] = jsonData<{ claims: Array<{ expired: boolean }> }>(expired.stdout).claims;
    expect(expiredClaim.expired).toBe(true);
  });

  it("does not leak a launched agent identity into another repository", async () => {
    const outerRepository = await createRepository();
    await exec(process.execPath, [cli, "setup"], outerRepository);
    await exec(
      process.execPath,
      [cli, "start", "Outer task", "--name", "outer-task", "--agent", "claude", "--no-launch"],
      outerRepository,
    );

    const innerRepository = await createRepository();
    await exec(process.execPath, [cli, "setup"], innerRepository);
    await exec(
      process.execPath,
      [cli, "start", "Inner task", "--name", "inner-task", "--agent", "codex", "--no-launch"],
      innerRepository,
    );
    const status = await exec(process.execPath, [cli, "status", "--json"], innerRepository);
    const [innerWorkspace] = jsonData<Array<{ worktree: string }>>(status.stdout);

    await exec(process.execPath, [cli, "claim", "src/**", "--write"], innerWorkspace.worktree, {
      MUXTRA_AGENT: "claude",
      MUXTRA_WORKSPACE: "outer-task",
    });
    const claims = await exec(process.execPath, [cli, "who", "--json"], innerWorkspace.worktree);
    expect(
      jsonData<{ claims: Array<{ agent: string; workspace: string }> }>(claims.stdout).claims,
    ).toMatchObject([{ agent: "codex", workspace: "inner-task" }]);
  });
});
