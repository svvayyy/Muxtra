import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { CliError } from "./errors.js";
import { gitRoot } from "./git.js";

const commandSchema = z.string().min(1);
const laneSelectionSchema = z.object({
  agent: z.enum(["claude", "codex"]),
  model: z.string().min(1).optional(),
});
const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => {
    const segments = value.split(/[\\/]+/);
    return (
      !path.isAbsolute(value) &&
      !segments.includes("..") &&
      segments.some((segment) => segment !== "" && segment !== ".")
    );
  }, "must be a relative path that stays inside the repository");

export const projectConfigSchema = z.object({
  version: z.literal(1),
  project: z.object({
    name: z.string().min(1),
  }),
  repository: z.object({
    default_branch: z.string().min(1).default("main"),
  }),
  runtime: z.object({
    install: commandSchema.optional(),
    development: commandSchema.optional(),
    healthcheck: z.string().optional(),
    port_env: z.string().min(1).default("PORT"),
    environment: z
      .object({
        provider: z.enum(["inherit", "vercel"]).default("inherit"),
        target: z.string().min(1).default("development"),
      })
      .default({ provider: "inherit", target: "development" }),
    copy_into_workspaces: z.array(repositoryRelativePathSchema).default([]),
  }),
  checks: z.array(commandSchema).default([]),
  lanes: z
    .object({
      design: laneSelectionSchema.optional(),
      code: laneSelectionSchema.optional(),
    })
    .default({}),
  git: z.object({
    branch_prefix: z.string().min(1).default("agent"),
    agents_may_commit: z.boolean().default(true),
    agents_may_push_feature_branches: z.boolean().default(true),
    direct_push_to_main: z.boolean().default(false),
    force_push: z.boolean().default(false),
  }),
  providers: z
    .object({
      vercel: z
        .object({
          enabled: z.boolean().default(false),
          team: z.string().optional(),
          project: z.string().optional(),
          production_branch: z.string().optional(),
        })
        .optional(),
    })
    .default({}),
  production: z.object({
    requires_approval: z.boolean().default(true),
    deploy_by_merging: z.boolean().default(true),
  }),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export interface LoadedConfig {
  root: string;
  path: string;
  config: ProjectConfig;
}

const CONFIG_PATHS = [
  path.join(".muxtra", "project.yaml"),
  path.join(".parallel-agent", "project.yaml"),
];

async function existingConfigPath(root: string): Promise<string | undefined> {
  for (const relativePath of CONFIG_PATHS) {
    const candidate = path.join(root, relativePath);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the legacy location before reporting that the project is not configured.
    }
  }
  return undefined;
}

export async function configExists(root: string): Promise<boolean> {
  return Boolean(await existingConfigPath(root));
}

export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const root = await gitRoot(cwd);
  const configPath = await existingConfigPath(root);
  let source: string;

  if (!configPath) {
    throw new CliError(
      `No Muxtra project contract found at ${path.join(root, ".muxtra", "project.yaml")}. ` +
        'Run "muxtra setup" first. Use "muxtra init" only when you want to configure and commit the contract manually.',
    );
  }
  source = await readFile(configPath, "utf8");

  try {
    const config = projectConfigSchema.parse(parse(source));
    return { root, path: configPath, config };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("\n");
      throw new CliError(`Invalid ${configPath}:\n${details}`);
    }
    throw error;
  }
}
