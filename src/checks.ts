import { setTimeout as delay } from "node:timers/promises";
import { attributeFailure, type FailureAttribution } from "./attribution.js";
import { describeAge, heartbeatIdentity, readClaims } from "./claims.js";
import { loadConfig } from "./config.js";
import { CliError } from "./errors.js";
import { gitBranch, gitHead, gitStatus } from "./git.js";
import { resolveIdentity } from "./identity.js";
import { runShellCapture } from "./process.js";
import { readGreen, recordGreen, type GreenRecord } from "./state.js";

export interface CheckRunOptions {
  agent?: string;
  json?: boolean;
  wait?: string;
}

export interface SuccessfulCheckReport {
  ok: true;
  checkCount: number;
  attempts: number;
  dirty: boolean;
  green: GreenRecord | null;
  lastGreen: GreenRecord | null;
}

export interface FailedCheckReport {
  ok: false;
  checkCount: number;
  attempts: number;
  failure: FailureAttribution;
  lastGreen: GreenRecord | null;
}

export type CheckReport = SuccessfulCheckReport | FailedCheckReport;

/** Accepts `600`, `30s`, `10m`, `1h`. */
export function parseDuration(value: string): number {
  const match = /^(\d+)(s|m|h)?$/.exec(value.trim());
  if (!match) {
    throw new CliError(`Could not read a duration from "${value}". Use 30s, 10m, or 1h.`);
  }
  const amount = Number(match[1]);
  switch (match[2]) {
    case "m":
      return amount * 60;
    case "h":
      return amount * 3_600;
    default:
      return amount;
  }
}

/**
 * Programmatic check runner shared by CLI commands and future agent/UI adapters.
 * Check output is streamed as it runs; the final structured report is returned.
 */
export async function runProjectChecks(
  cwd: string,
  options: CheckRunOptions = {},
): Promise<CheckReport> {
  const { root, config } = await loadConfig(cwd);
  if (config.checks.length === 0) {
    throw new CliError('No checks are configured. Add a "checks:" list to .muxtra/project.yaml.');
  }

  const identity = await resolveIdentity(root, options.agent);
  const waitSeconds = options.wait ? parseDuration(options.wait) : 0;
  const deadline = Date.now() + waitSeconds * 1_000;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    await heartbeatIdentity(root, identity.agent, identity.workspace);
    const failure = await runChecks(root, config.checks, identity, Boolean(options.json));

    if (!failure) {
      const dirty = Boolean(await gitStatus(root));
      const green = dirty
        ? null
        : {
            sha: await gitHead(root),
            branch: await gitBranch(root),
            at: new Date().toISOString(),
            agent: identity.agent,
            checks: config.checks,
          };
      if (green) await recordGreen(root, green);
      return {
        ok: true,
        checkCount: config.checks.length,
        attempts: attempt,
        dirty,
        green,
        lastGreen: green ?? (await readGreen(root)),
      };
    }

    const canRetry =
      waitSeconds > 0 && Date.now() < deadline && failure.verdict === "claimed-by-other";
    if (!canRetry) {
      return {
        ok: false,
        checkCount: config.checks.length,
        attempts: attempt,
        failure,
        lastGreen: await readGreen(root),
      };
    }

    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1_000));
    console.error(
      `\n✖ ${failure.check} failed and intersects another agent's write claim. ` +
        `Waiting before retry; ${describeAge(remaining)} of budget left.\n`,
    );
    await delay(Math.min(20_000, Math.max(5_000, remaining * 100)));
  }
}

async function runChecks(
  root: string,
  checks: string[],
  identity: Awaited<ReturnType<typeof resolveIdentity>>,
  asJson: boolean,
): Promise<FailureAttribution | null> {
  const echoStdoutTo = asJson ? process.stderr : process.stdout;

  for (const check of checks) {
    (asJson ? console.error : console.log)(`→ ${check}`);
    const result = await runShellCapture(check, root, echoStdoutTo);
    if (result.code === 0) continue;

    return attributeFailure({
      root,
      check,
      exitCode: result.code,
      output: result.output,
      identity,
      claims: await readClaims(root),
    });
  }
  return null;
}
