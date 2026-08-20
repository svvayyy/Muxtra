import { discoverAgentInstallations } from "../agents.js";
import { loadConfig } from "../config.js";
import { gitBranch, remoteUrl, resolveBaseRef } from "../git.js";
import { commandExists, run } from "../process.js";
import { table } from "../format.js";
import { findVercelProjectLink } from "../runtime.js";

type Check = [string, "ok" | "warn" | "error", string];

export async function doctorCommand(cwd: string): Promise<void> {
  const { root, config } = await loadConfig(cwd);
  const checks: Check[] = [];

  if (await commandExists("git")) {
    const { stdout } = await run("git", ["--version"], root);
    checks.push(["git", "ok", stdout]);
  } else {
    checks.push(["git", "error", "not installed"]);
  }

  const branch = await gitBranch(root);
  checks.push(["checkout", "ok", branch]);

  const remote = await remoteUrl(root);
  checks.push([
    "origin",
    remote ? "ok" : "warn",
    remote ?? "not configured; remote checkpoints and previews unavailable",
  ]);

  const baseRef = await resolveBaseRef(root, config.repository.default_branch);
  checks.push(["base", "ok", baseRef]);

  if (config.runtime.install) {
    const executable = config.runtime.install.trim().split(/\s+/)[0];
    checks.push(["runtime", (await commandExists(executable)) ? "ok" : "error", executable]);
  } else {
    checks.push(["runtime", "warn", "install command is not configured"]);
  }

  if (config.providers.vercel?.enabled) {
    checks.push([
      "vercel",
      (await commandExists("vercel")) ? "ok" : "error",
      config.providers.vercel.project ?? "enabled but project is not configured",
    ]);
    const link = await findVercelProjectLink(root);
    checks.push([
      "vercel link",
      link ? "ok" : "warn",
      link
        ? link.source === "primary"
          ? ".vercel/project.json available in primary checkout"
          : ".vercel/project.json"
        : "run vercel link in the primary checkout",
    ]);
  } else {
    checks.push(["vercel", "warn", "provider disabled"]);
  }

  for (const agent of await discoverAgentInstallations()) {
    checks.push([
      agent.label,
      agent.installed ? "ok" : "warn",
      agent.version ?? "not installed; managed launch unavailable",
    ]);
  }

  console.log(table([["CHECK", "STATUS", "DETAIL"], ...checks]));
  const errors = checks.filter(([, status]) => status === "error");
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}
