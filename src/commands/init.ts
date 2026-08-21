import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { configExists } from "../config.js";
import { CliError } from "../errors.js";
import { defaultBranch, gitRoot } from "../git.js";
import { installGuidePointer } from "../agentGuide.js";
import { projectConfigSchema } from "../config.js";

async function detectPackageCommands(root: string): Promise<{
  install?: string;
  development?: string;
  checks: string[];
}> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      packageManager?: string;
      scripts?: Record<string, string>;
    };
    const manager = packageJson.packageManager?.split("@")[0] || "npm";
    const scripts = packageJson.scripts ?? {};
    const run = (script: string) => `${manager} ${manager === "npm" ? "run " : ""}${script}`;
    const checks = ["lint", "typecheck", "test", "build"]
      .filter((script) => scripts[script])
      .map(run);
    return {
      install: `${manager} install`,
      development: scripts.dev ? run("dev") : undefined,
      checks,
    };
  } catch {
    return { checks: [] };
  }
}

export async function initCommand(
  cwd: string,
  installGuide = false,
  concise = false,
): Promise<void> {
  const root = await gitRoot(cwd);
  if (await configExists(root)) {
    throw new CliError("This repository already contains .muxtra/project.yaml.");
  }

  const name = path.basename(root);
  const primaryBranch = await defaultBranch(root);
  const detected = await detectPackageCommands(root);
  const configDirectory = path.join(root, ".muxtra");
  await mkdir(configDirectory, { recursive: true });

  const config = {
    version: 1,
    project: { name },
    repository: { default_branch: primaryBranch },
    runtime: {
      ...(detected.install ? { install: detected.install } : {}),
      ...(detected.development ? { development: detected.development } : {}),
      healthcheck: "/",
      port_env: "PORT",
      environment: {
        provider: "inherit",
        target: "development",
      },
      copy_into_workspaces: [],
    },
    checks: detected.checks,
    lanes: {
      design: { agent: "claude" },
      code: { agent: "codex" },
    },
    git: {
      branch_prefix: "agent",
      agents_may_commit: true,
      agents_may_push_feature_branches: true,
      direct_push_to_main: false,
      force_push: false,
    },
    providers: {
      vercel: {
        enabled: false,
        production_branch: primaryBranch,
      },
    },
    production: {
      requires_approval: true,
      deploy_by_merging: true,
    },
  };

  await writeFile(path.join(configDirectory, "project.yaml"), stringify(config), "utf8");

  console.log(`Initialized Muxtra in ${root}`);
  console.log("Created .muxtra/project.yaml");
  if (installGuide) {
    const parsed = projectConfigSchema.parse(config);
    const guideOutcome = await installGuidePointer(root, "AGENTS.md", parsed);
    console.log(
      guideOutcome === "created"
        ? "Created AGENTS.md with the Muxtra protocol"
        : "Added the Muxtra protocol to AGENTS.md",
    );
  } else if (!concise) {
    console.log('Agent instructions unchanged; run "muxtra install-guide" to add an opt-in guide.');
  }
  if (!concise) console.log("\nReview the contract, then run: muxtra doctor");
}
