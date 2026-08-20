import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(projectRoot, "dist", "cli.js");
const temporaryDirectories: string[] = [];

function jsonData<T>(stdout: string): T {
  const envelope = JSON.parse(stdout) as { schemaVersion: number; data: T };
  expect(envelope.schemaVersion).toBe(1);
  return envelope.data;
}

interface ExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function exec(command: string, args: string[], cwd: string): Promise<ExecOutcome> {
  try {
    const result = await execFileAsync(command, args, { cwd, encoding: "utf8" });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const cause = error as { code?: number; stdout?: string; stderr?: string };
    return { code: cause.code ?? 1, stdout: cause.stdout ?? "", stderr: cause.stderr ?? "" };
  }
}

const muxtra = (args: string[], cwd: string) => exec(process.execPath, [cli, ...args], cwd);

/**
 * Reproduces the collision this feature exists for: one agent widens a type while a
 * second agent, working elsewhere in the tree, runs a build and sees it break.
 */
async function createRepository(failing: boolean): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "muxtra-build-test-"));
  temporaryDirectories.push(root);

  await exec("git", ["init", "-b", "main"], root);
  await exec("git", ["config", "user.email", "tests@example.com"], root);
  await exec("git", ["config", "user.name", "Muxtra Tests"], root);

  await mkdir(path.join(root, ".muxtra"), { recursive: true });
  await writeFile(
    path.join(root, ".muxtra", "project.yaml"),
    [
      "version: 1",
      "project:",
      "  name: example",
      "repository:",
      "  default_branch: main",
      "runtime:",
      "  port_env: PORT",
      "  environment:",
      "    provider: inherit",
      "    target: development",
      "  copy_into_workspaces: []",
      "checks:",
      "  - node check.mjs",
      "git:",
      "  branch_prefix: agent",
      "  agents_may_commit: true",
      "  agents_may_push_feature_branches: true",
      "  direct_push_to_main: false",
      "  force_push: false",
      "production:",
      "  requires_approval: true",
      "  deploy_by_merging: true",
      "",
    ].join("\n"),
  );

  await mkdir(path.join(root, "core"), { recursive: true });
  await mkdir(path.join(root, "ui"), { recursive: true });
  await writeFile(path.join(root, "core", "suite.js"), "export const arms = 8;\n");
  await writeFile(path.join(root, "ui", "view.js"), "export const view = 1;\n");
  await writeFile(
    path.join(root, "check.mjs"),
    failing
      ? 'console.error("core/suite.js:78:9: error: switch must be exhaustive");\nprocess.exit(1);\n'
      : 'console.log("ok");\n',
  );

  await exec("git", ["add", "."], root);
  await exec("git", ["commit", "-m", "Initial commit"], root);
  return root;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("muxtra build attribution", () => {
  it("reports the agent holding a write claim over the failing file", async () => {
    const root = await createRepository(true);
    await muxtra(["claim", "core/**", "--agent", "bob", "--task", "widen the enum"], root);

    const result = await muxtra(["build", "--agent", "claude", "--json"], root);
    const report = jsonData<{
      ok: boolean;
      failure: {
        verdict: string;
        failingPaths: { path: string }[];
        foreignClaims: { agent: string; matched: string[] }[];
      };
    }>(result.stdout);

    expect(result.code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.failure.verdict).toBe("claimed-by-other");
    expect(report.failure.failingPaths[0].path).toBe("core/suite.js");
    expect(report.failure.foreignClaims[0].agent).toBe("bob");
    expect(report.failure.foreignClaims[0].matched).toContain("core/suite.js");
  });

  it("reports when the failure is inside your own write claim", async () => {
    const root = await createRepository(true);

    const result = await muxtra(["build", "--agent", "bob", "--json"], root);
    await muxtra(["claim", "core/**", "--agent", "bob"], root);
    const owned = await muxtra(["build", "--agent", "bob", "--json"], root);
    const report = jsonData<{ failure: { verdict: string; yours: string[] } }>(owned.stdout);

    expect(result.code).toBe(1);
    expect(report.failure.verdict).toBe("claimed-by-you");
    expect(report.failure.yours).toContain("core/suite.js");
  });

  it("reports uncommitted edits outside the current claim without assigning blame", async () => {
    const root = await createRepository(true);
    await muxtra(["claim", "ui/**", "--agent", "claude"], root);
    // The editor is unknown; the registry should only report that the lane is incomplete.
    await writeFile(path.join(root, "core", "suite.js"), "export const arms = 21;\n");

    const result = await muxtra(["build", "--agent", "claude", "--json"], root);
    const report = jsonData<{
      failure: { verdict: string; dirtyOutsideYourClaim: { path: string }[] };
    }>(result.stdout);

    expect(report.failure.verdict).toBe("outside-your-claim");
    expect(report.failure.dirtyOutsideYourClaim.map((entry) => entry.path)).toContain(
      "core/suite.js",
    );
  });

  it("records a green commit when every check passes", async () => {
    const root = await createRepository(false);
    const result = await muxtra(["build", "--agent", "claude", "--json"], root);
    const report = jsonData<{
      ok: boolean;
      green: { sha: string; branch: string; agent: string };
    }>(result.stdout);

    expect(result.code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.green.branch).toBe("main");
    expect(report.green.agent).toBe("claude");
    expect(report.green.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("runs repository contract checks from the repository root", async () => {
    const root = await createRepository(false);
    const result = await muxtra(["build", "--agent", "claude", "--json"], path.join(root, "ui"));
    const report = jsonData<{ ok: boolean; green: { sha: string } }>(result.stdout);

    expect(result.code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.green.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("does not record HEAD as green when checks pass with uncommitted changes", async () => {
    const root = await createRepository(false);
    await writeFile(path.join(root, "ui", "view.js"), "export const view = 2;\n");

    const result = await muxtra(["build", "--agent", "claude", "--json"], root);
    const report = jsonData<{
      ok: boolean;
      dirty: boolean;
      green: null;
      lastGreen: null;
    }>(result.stdout);

    expect(result.code).toBe(0);
    expect(report).toMatchObject({ ok: true, dirty: true, green: null, lastGreen: null });
  });

  it("does not treat a foreign read claim as failure ownership", async () => {
    const root = await createRepository(true);
    await muxtra(["claim", "core/**", "--read", "--agent", "bob"], root);

    const result = await muxtra(["build", "--agent", "claude", "--json"], root);
    const report = jsonData<{
      failure: { verdict: string; foreignClaims: unknown[] };
    }>(result.stdout);

    expect(report.failure.verdict).toBe("unattributed");
    expect(report.failure.foreignClaims).toEqual([]);
  });

  it("reports mixed claims instead of assigning the failure to one agent", async () => {
    const root = await createRepository(true);
    await muxtra(["claim", "core/**", "--write", "--agent", "bob"], root);
    await muxtra(["claim", "core/**", "--write", "--agent", "claude"], root);

    const result = await muxtra(["build", "--agent", "claude", "--json"], root);
    const report = jsonData<{
      failure: { verdict: string; yours: string[]; foreignClaims: unknown[] };
    }>(result.stdout);

    expect(report.failure.verdict).toBe("mixed-claims");
    expect(report.failure.yours).toContain("core/suite.js");
    expect(report.failure.foreignClaims).toHaveLength(1);
  });
});

describe("claims across agents", () => {
  it("reports an overlap without blocking the second agent", async () => {
    const root = await createRepository(false);
    await muxtra(["claim", "core/**", "--agent", "bob", "--task", "refactor"], root);

    const second = await muxtra(["claim", "core/models/**", "--agent", "claude", "--json"], root);
    const report = jsonData<{
      overlaps: { claim: { agent: string; task: string | null } }[];
    }>(second.stdout);

    expect(second.code).toBe(0);
    expect(report.overlaps).toHaveLength(1);
    expect(report.overlaps[0].claim.agent).toBe("bob");
    expect(report.overlaps[0].claim.task).toBe("refactor");
  });

  it("exits non-zero on overlap only when asked", async () => {
    const root = await createRepository(false);
    await muxtra(["claim", "core/**", "--agent", "bob"], root);
    await muxtra(["claim", "ui/**", "--agent", "claude"], root);

    const strict = await muxtra(
      ["claim", "core/**", "--agent", "claude", "--fail-on-conflict"],
      root,
    );
    expect(strict.code).toBe(2);

    const who = await muxtra(["who", "--json"], root);
    const claims = jsonData<{ claims: Array<{ agent: string; paths: string[] }> }>(
      who.stdout,
    ).claims;
    expect(claims.find((claim) => claim.agent === "claude")?.paths).toEqual(["ui/**"]);
  });

  it("accepts an explicit write flag and rejects paths outside the repository", async () => {
    const root = await createRepository(false);

    const written = await muxtra(["claim", "core/**", "--write", "--agent", "bob"], root);
    const escaped = await muxtra(["claim", "../private/**", "--agent", "claude"], root);

    expect(written.code).toBe(0);
    expect(escaped.code).toBe(1);
    expect(escaped.stderr).toContain("must stay inside the repository");
  });

  it("catches accidentally combined claim paths while allowing intentional spaces", async () => {
    const root = await createRepository(false);

    const combined = await muxtra(["claim", "core/suite.js ui/view.js", "--agent", "bob"], root);
    const intentional = await muxtra(
      ["claim", "docs/Product Guide.md", "--allow-space-paths", "--agent", "bob", "--json"],
      root,
    );

    expect(combined.code).toBe(1);
    expect(combined.stderr).toContain("Pass each path as a separate quoted argument");
    expect(jsonData<{ claim: { paths: string[] } }>(intentional.stdout).claim.paths).toEqual([
      "docs/Product Guide.md",
    ]);
  });

  it("lists and releases claims", async () => {
    const root = await createRepository(false);
    await muxtra(["claim", "core/**", "--agent", "bob"], root);
    await muxtra(["claim", "ui/**", "--agent", "claude"], root);

    const who = await muxtra(["who", "--json"], root);
    expect(jsonData<{ claims: unknown[] }>(who.stdout).claims).toHaveLength(2);

    await muxtra(["release", "--agent", "bob"], root);
    const after = await muxtra(["who", "--json"], root);
    const remaining = jsonData<{ claims: Array<{ agent: string }> }>(after.stdout).claims;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].agent).toBe("claude");
  });

  it("replaces an agent's previous claim rather than accumulating", async () => {
    const root = await createRepository(false);
    await muxtra(["claim", "core/**", "--agent", "bob"], root);
    await muxtra(["claim", "ui/**", "--agent", "bob"], root);

    const who = await muxtra(["who", "--json"], root);
    const claims = jsonData<{ claims: Array<{ paths: string[] }> }>(who.stdout).claims;
    expect(claims).toHaveLength(1);
    expect(claims[0].paths).toEqual(["ui/**"]);
  });
});
