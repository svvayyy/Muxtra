import { closeSync, openSync } from "node:fs";
import { access, appendFile, copyFile, mkdir, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CliError } from "./errors.js";
import { gitCommonDir, gitRoot } from "./git.js";

export async function allocatePort(requested?: number): Promise<number> {
  if (
    requested !== undefined &&
    (!Number.isInteger(requested) || requested < 1 || requested > 65535)
  ) {
    throw new CliError(`Invalid port: ${requested}`);
  }

  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        reject(new CliError(`Port ${requested} is already in use.`));
      } else {
        reject(error);
      }
    });
    server.listen({ host: "127.0.0.1", port: requested ?? 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new CliError("Could not allocate a local development port."));
      });
    });
  });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shellInvocation(command: string): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return { executable: "/bin/sh", args: ["-lc", command] };
}

export interface StartProcessOptions {
  command: string;
  cwd: string;
  logPath: string;
  environment: NodeJS.ProcessEnv;
  environmentProvider: "inherit" | "vercel";
  environmentTarget: string;
}

export async function startDevelopmentProcess(options: StartProcessOptions): Promise<number> {
  await mkdir(path.dirname(options.logPath), { recursive: true });
  await appendFile(
    options.logPath,
    `\n[muxtra ${new Date().toISOString()}] starting: ${options.command}\n`,
    "utf8",
  );
  const logDescriptor = openSync(options.logPath, "a");
  const shell = shellInvocation(options.command);
  const executable = options.environmentProvider === "vercel" ? "vercel" : shell.executable;
  const args =
    options.environmentProvider === "vercel"
      ? ["env", "run", "-e", options.environmentTarget, "--", shell.executable, ...shell.args]
      : shell.args;

  try {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      detached: true,
      env: options.environment,
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        if (child.pid) resolve(child.pid);
        else reject(new CliError("Development process did not return a PID."));
      });
    });
    child.unref();
    return pid;
  } finally {
    closeSync(logDescriptor);
  }
}

export async function prepareVercelProjectLink(
  repositoryRoot: string,
  laneWorktree: string,
): Promise<void> {
  const location = await findVercelProjectLink(repositoryRoot);
  if (!location) {
    throw new CliError(
      "Vercel environment injection requires .vercel/project.json in the primary checkout. " +
        'Run "vercel link" there first.',
    );
  }
  const source = location.path;
  const destination = path.join(laneWorktree, ".vercel", "project.json");
  let sourceLink: { orgId?: string; projectId?: string };
  try {
    sourceLink = JSON.parse(await readFile(source, "utf8")) as {
      orgId?: string;
      projectId?: string;
    };
  } catch {
    throw new CliError(`Could not read the Vercel project link at ${source}.`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  let destinationSource: string;
  try {
    destinationSource = await readFile(destination, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await copyFile(source, destination);
      return;
    }
    throw error;
  }
  const destinationLink = JSON.parse(destinationSource) as {
    orgId?: string;
    projectId?: string;
  };
  if (
    sourceLink.orgId !== destinationLink.orgId ||
    sourceLink.projectId !== destinationLink.projectId
  ) {
    throw new CliError(
      `The workspace is linked to a different Vercel project: ${destination}. ` +
        "Remove or correct that link before starting the server.",
    );
  }
}

export interface VercelProjectLinkLocation {
  root: string;
  path: string;
  source: "current" | "primary";
}

/**
 * A launched agent runs inside a linked Git worktree, while Vercel stores its ignored
 * project link in the primary checkout. Resolve through Git's common directory so
 * `muxtra dev` behaves the same whether invoked from the primary checkout or the lane.
 */
export async function findVercelProjectLink(
  cwd: string,
): Promise<VercelProjectLinkLocation | null> {
  const [currentRoot, commonDir] = await Promise.all([gitRoot(cwd), gitCommonDir(cwd)]);
  const primaryRoot = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : currentRoot;
  const candidates = [primaryRoot, currentRoot].filter(
    (candidate, index, roots) => roots.indexOf(candidate) === index,
  );

  for (const root of candidates) {
    const filePath = path.join(root, ".vercel", "project.json");
    try {
      await access(filePath);
      return { root, path: filePath, source: root === currentRoot ? "current" : "primary" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  return null;
}

export async function waitForHttp(
  url: string,
  pid: number,
  timeoutMs = 15_000,
): Promise<"ready" | "exited" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return "exited";
    try {
      await fetch(url, { signal: AbortSignal.timeout(1_000), redirect: "manual" });
      return "ready";
    } catch {
      await delay(200);
    }
  }
  return isProcessAlive(pid) ? "timeout" : "exited";
}

export async function stopProcess(pid: number, force: boolean): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(100);
  }
  return !isProcessAlive(pid);
}
