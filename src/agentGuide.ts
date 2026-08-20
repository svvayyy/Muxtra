import { readFile, writeFile } from "node:fs/promises";
import type { ProjectConfig } from "./config.js";
import { CliError } from "./errors.js";
import { resolveWithin } from "./paths.js";

export const GUIDE_BEGIN = "<!-- muxtra:begin -->";
export const GUIDE_END = "<!-- muxtra:end -->";

/**
 * The operating manual an agent reads. It is deliberately imperative and short: an
 * agent acts on what is in its context window, so anything longer than a screen gets
 * skimmed and anything phrased as background gets ignored.
 */
export function buildAgentGuide(config: ProjectConfig): string {
  const checks = config.checks.length > 0 ? config.checks.join(", ") : "none configured";

  return `# Working here alongside other agents

This repository is managed by Muxtra (\`muxtra\`). Other agents may be
editing it **at the same time as you**, in this checkout or in a sibling worktree you
cannot see. These commands are how you find out.

## Do this first, before editing anything

    muxtra context --json        # project workflow, policy, and who else is active
    muxtra who                   # every agent's declared paths, right now
    muxtra claim --write "<paths you will edit>" --task "<one line>"

\`claim\` does not lock anything and never blocks you. It publishes your intent so the
next agent — and the build — can reason about who intends to touch what. If it reports an
OVERLAP, coordinate or narrow your paths before writing code.

Claim the paths you expect to touch, all at once. Replacing the claim file-by-file
creates avoidable registry churn and makes overlap warnings less useful.
Pass each path as its own argument, for example:

    muxtra claim --write "src/feature.ts" "src/feature.test.ts" --task "Add feature"

## Use muxtra for setup and the development server

    muxtra bootstrap             # inspect prerequisites and the configured install
    muxtra bootstrap --apply     # run the configured install when dependencies are missing
    muxtra dev                   # start a tracked server with the configured environment

Do not substitute a raw package-manager install or development command. Muxtra uses the
repository contract, tracks the process and port, and injects the configured environment.
Use \`muxtra logs <workspace>\` to inspect it and \`muxtra stop <workspace>\` when finished.

## Build with muxtra, not with the raw commands

    muxtra build                 # runs: ${checks}
    muxtra build --wait 10m      # retry while another agent finishes

Never run the check commands directly. \`muxtra build\` runs exactly the same checks,
and when one fails it cross-references the named files with active write claims:

- \`Verdict: CLAIMED BY YOU\` — the failing files are inside your declared lane.
- \`Verdict: CLAIMED BY ANOTHER AGENT\` — coordinate before editing those paths.
- \`Verdict: MIXED CLAIMS\` — both your lane and another agent's lane intersect the
  failure, so the registry cannot assign responsibility.
- \`Verdict: OUTSIDE YOUR CLAIM\` — uncommitted failing files are outside your declared
  lane; inspect the diff and widen your claim if they are yours.
- \`Verdict: UNATTRIBUTED\` — no signal either way. Investigate normally.

Claims are ownership signals, not proof of who caused a compiler or test failure. A
diagnostic can point at a file even when the root cause is elsewhere, and edits in a
sibling worktree are not part of your current build. Use the verdict to respect lanes
and coordinate, not to assign blame automatically.

## When you finish

    muxtra finish                # verify the branch and drop your claim when ready

\`finish\` requires committed changes on the recorded branch, a current base, no running
development server, and passing project checks. It does not push or merge anything.
The human can then combine verified tasks from the primary project with \`muxtra combine\`.
If you stop without finishing, your claim expires on its own; \`muxtra who\` shows it as
\`expired\` so a human can clear it. Use \`muxtra release\` only when abandoning work that
should not be handed off for integration.

## Rules that are not negotiable

1. Do not edit files inside another agent's active write claim.
2. Treat build verdicts as coordination evidence, not proof of responsibility.
3. If your task needs paths outside your claim, re-claim with the wider set. If the
   wider set overlaps someone else, stop and ask the human — that is a decision for a
   person, not something to resolve by editing faster.
4. Direct pushes to ${config.repository.default_branch} are ${
    config.git.direct_push_to_main ? "allowed by project policy" : "forbidden"
  }. Force pushes are ${config.git.force_push ? "allowed by project policy" : "forbidden"}.
`;
}

/** A compact pointer for AGENTS.md / CLAUDE.md, kept between managed markers. */
export function buildGuidePointer(config: ProjectConfig): string {
  return `${GUIDE_BEGIN}
## Parallel agents

Other agents may be editing this repository at the same time as you.

Before editing, run:

    muxtra context --json
    muxtra claim --write "<paths you will edit>" --task "<one line>"

Use \`muxtra bootstrap --apply\` when dependencies are missing and \`muxtra dev\` for the
development server; do not run the raw install or development commands.

Build with \`muxtra build\` rather than running ${
    config.checks.length > 0 ? `\`${config.checks[0]}\`` : "the checks"
  } directly — it cross-references failing paths with active claims so agents can
coordinate before editing the same files. Run \`muxtra agent-guide\` for the full protocol.
After committing the task, run \`muxtra finish\` to verify that the branch is ready for
integration and release its claim. The human combines verified tasks separately.
${GUIDE_END}`;
}

/**
 * Writes the pointer into the file agents already read at session start. A CLI that is
 * not mentioned in AGENTS.md is invisible to an agent no matter how good it is; this
 * is the whole discovery mechanism.
 */
export async function installGuidePointer(
  root: string,
  fileName: string,
  config: ProjectConfig,
): Promise<"created" | "updated" | "unchanged"> {
  let filePath: string;
  try {
    filePath = resolveWithin(root, fileName);
  } catch (error) {
    throw new CliError((error as Error).message);
  }
  const pointer = buildGuidePointer(config);

  let existing: string;
  try {
    existing = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(filePath, `${pointer}\n`, "utf8");
    return "created";
  }

  const begin = existing.indexOf(GUIDE_BEGIN);
  const end = existing.indexOf(GUIDE_END);
  const duplicateBegin =
    begin === -1 ? -1 : existing.indexOf(GUIDE_BEGIN, begin + GUIDE_BEGIN.length);
  const duplicateEnd = end === -1 ? -1 : existing.indexOf(GUIDE_END, end + GUIDE_END.length);

  if (
    (begin === -1) !== (end === -1) ||
    (begin !== -1 && end < begin) ||
    duplicateBegin !== -1 ||
    duplicateEnd !== -1
  ) {
    throw new CliError(
      `${fileName} contains malformed or duplicate muxtra guide markers. ` +
        "Repair the markers before running install-guide again.",
    );
  }

  if (begin !== -1 && end !== -1 && end > begin) {
    const replaced = existing.slice(0, begin) + pointer + existing.slice(end + GUIDE_END.length);
    if (replaced === existing) return "unchanged";
    await writeFile(filePath, replaced, "utf8");
    return "updated";
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(filePath, `${existing}${separator}${pointer}\n`, "utf8");
  return "updated";
}
