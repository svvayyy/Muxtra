import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { CliError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
}

export async function run(command: string, args: string[], cwd: string): Promise<RunResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
    };
    const detail = cause.stderr?.trim() || cause.stdout?.trim() || cause.message;
    throw new CliError(`${command} ${args.join(" ")} failed: ${detail}`);
  }
}

export async function commandExists(command: string): Promise<boolean> {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(checker, [command]);
    return true;
  } catch {
    return false;
  }
}

export async function runShellCommand(command: string, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new CliError(`Command failed with exit code ${code}: ${command}`));
      }
    });
  });
}

export async function runInteractiveCommand(
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  observer: {
    onSpawn?: (pid: number) => void | Promise<void>;
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void | Promise<void>;
  } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let spawnObservation = Promise.resolve();
    let observationError: unknown;
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: "inherit",
    });

    child.on("spawn", () => {
      if (child.pid !== undefined) {
        spawnObservation = Promise.resolve(observer.onSpawn?.(child.pid))
          .then(() => undefined)
          .catch((error: unknown) => {
            observationError = error;
          });
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new CliError(`Agent executable is not installed or not on PATH: ${command}`));
        return;
      }
      reject(error);
    });
    child.on("exit", async (code, signal) => {
      await spawnObservation;
      try {
        await observer.onExit?.(code, signal);
      } catch (error) {
        observationError = observationError ?? error;
      }
      if (observationError) {
        reject(observationError);
        return;
      }
      if (code === 0) {
        resolve();
      } else if (signal) {
        reject(new CliError(`${command} exited after receiving ${signal}.`));
      } else {
        reject(new CliError(`${command} exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}

export interface CapturedRun {
  code: number;
  output: string;
}

const MAX_CAPTURED_OUTPUT_CHARACTERS = 10 * 1024 * 1024;

/**
 * Runs a configured check, streaming it to the terminal while keeping a copy. The copy
 * is what failure attribution reads file names out of.
 */
export async function runShellCapture(
  command: string,
  cwd: string,
  echoStdoutTo: NodeJS.WritableStream = process.stdout,
): Promise<CapturedRun> {
  return new Promise<CapturedRun>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const capture = (text: string) => {
      output += text;
      if (output.length > MAX_CAPTURED_OUTPUT_CHARACTERS) {
        output = output.slice(-MAX_CAPTURED_OUTPUT_CHARACTERS);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      capture(text);
      echoStdoutTo.write(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      capture(text);
      process.stderr.write(text);
    });

    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, output }));
  });
}
