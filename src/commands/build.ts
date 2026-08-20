import { renderAttribution } from "../attribution.js";
import {
  parseDuration,
  runProjectChecks,
  type CheckRunOptions as BuildOptions,
} from "../checks.js";
import { describeAge } from "../claims.js";
import { CliError } from "../errors.js";
import { printJson } from "../protocol.js";

export { parseDuration };
export type { BuildOptions };

export async function buildCommand(cwd: string, options: BuildOptions): Promise<void> {
  const report = await runProjectChecks(cwd, options);

  if (options.json) {
    printJson("build", report);
  } else if (report.ok) {
    console.log(`\n✔ all ${report.checkCount} checks passed`);
    if (report.green) {
      console.log(`  green at ${report.green.sha.slice(0, 7)} on ${report.green.branch}`);
    } else {
      console.warn("  working tree has uncommitted changes; last-known-green was not updated");
    }
  } else {
    console.error(`\n✖ check failed: ${report.failure.check}`);
    console.error("");
    console.error(renderAttribution(report.failure));
    if (report.lastGreen) {
      const ageSeconds = Math.max(0, (Date.now() - Date.parse(report.lastGreen.at)) / 1_000);
      console.error("");
      console.error(
        `Last green: ${report.lastGreen.sha.slice(0, 7)} on ${report.lastGreen.branch} ` +
          `(${describeAge(ageSeconds)} ago, recorded by ${report.lastGreen.agent})`,
      );
    }
  }

  if (!report.ok) throw new CliError("Checks failed.", 1);
}
