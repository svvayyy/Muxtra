import { stat } from "node:fs/promises";
import path from "node:path";
import { type ClaimView, claimMatchesPath, describeAge, identityKey } from "./claims.js";
import type { AgentIdentity } from "./identity.js";
import { run } from "./process.js";

export interface SuspectPath {
  path: string;
  modifiedSecondsAgo: number | null;
  dirty: boolean;
}

export interface ForeignClaimMatch {
  agent: string;
  workspace: string | null;
  task: string | null;
  mode: string;
  paths: string[];
  ageSeconds: number;
  idleSeconds: number;
  matched: string[];
}

export type Verdict =
  "claimed-by-you" | "claimed-by-other" | "mixed-claims" | "outside-your-claim" | "unattributed";

export interface FailureAttribution {
  check: string;
  exitCode: number;
  failingPaths: SuspectPath[];
  yours: string[];
  foreignClaims: ForeignClaimMatch[];
  dirtyOutsideYourClaim: SuspectPath[];
  verdict: Verdict;
  yourClaims: string[];
}

/**
 * Compiler and test output is the only place a failure names its files, so the paths
 * are read back out of it. Two shapes cover almost everything: `file:line:col:` from
 * clang/swift/eslint/rust, and `file(line,col)` from tsc and MSVC.
 */
const COLON_REFERENCE = /([^\s:()[\]"'`,]+\.[A-Za-z][A-Za-z0-9]*):(\d+)(?::\d+)?/g;
const PAREN_REFERENCE = /([^\s:()[\]"'`,]+\.[A-Za-z][A-Za-z0-9]*)\((\d+),\d+\)/g;

export function extractPaths(output: string, root: string, limit = 25): string[] {
  const found = new Set<string>();

  for (const pattern of [COLON_REFERENCE, PAREN_REFERENCE]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      const candidate = match[1];
      if (!candidate || candidate.startsWith("http")) continue;

      const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
      const relative = path.relative(root, absolute);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;

      found.add(relative.split(path.sep).join("/"));
      if (found.size >= limit) return [...found];
    }
  }

  return [...found];
}

async function describeSuspect(
  root: string,
  relativePath: string,
  dirtyPaths: Set<string>,
): Promise<SuspectPath> {
  let modifiedSecondsAgo: number | null = null;
  try {
    const metadata = await stat(path.join(root, relativePath));
    modifiedSecondsAgo = Math.max(0, (Date.now() - metadata.mtimeMs) / 1_000);
  } catch {
    modifiedSecondsAgo = null;
  }
  return { path: relativePath, modifiedSecondsAgo, dirty: dirtyPaths.has(relativePath) };
}

export async function dirtyPaths(root: string): Promise<Set<string>> {
  try {
    const { stdout } = await run("git", ["status", "--porcelain"], root);
    const paths = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      // Status codes are two columns, but the first is a space for a work-tree-only
      // change and callers trim the output, so the leading space may be gone. Match
      // the code instead of slicing a fixed width.
      const match = /^(\S{1,2})\s+(.+)$/.exec(line.trimEnd());
      if (!match) continue;
      const candidate = match[2].trim();
      const renamed = candidate.split(" -> ").pop() ?? candidate;
      paths.add(renamed.replace(/^"|"$/g, ""));
    }
    return paths;
  } catch {
    return new Set();
  }
}

export async function attributeFailure(options: {
  root: string;
  check: string;
  exitCode: number;
  output: string;
  identity: AgentIdentity;
  claims: ClaimView[];
}): Promise<FailureAttribution> {
  const { root, check, exitCode, output, identity, claims } = options;
  const key = identityKey(identity.agent, identity.workspace);

  const mine = claims.filter(
    (claim) =>
      identityKey(claim.agent, claim.workspace) === key && !claim.expired && claim.mode === "write",
  );
  const theirs = claims.filter(
    (claim) =>
      identityKey(claim.agent, claim.workspace) !== key && !claim.expired && claim.mode === "write",
  );

  const dirty = await dirtyPaths(root);
  const extracted = extractPaths(output, root);
  const failingPaths = await Promise.all(
    extracted.map((candidate) => describeSuspect(root, candidate, dirty)),
  );

  const coveredByMe = (candidate: string) =>
    mine.some((claim) => claimMatchesPath(claim, candidate));

  const yours = failingPaths.filter((suspect) => coveredByMe(suspect.path)).map((s) => s.path);

  const foreignClaims: ForeignClaimMatch[] = [];
  for (const claim of theirs) {
    const matched = failingPaths
      .filter((suspect) => claimMatchesPath(claim, suspect.path))
      .map((suspect) => suspect.path);
    if (matched.length === 0) continue;
    foreignClaims.push({
      agent: claim.agent,
      workspace: claim.workspace,
      task: claim.task,
      mode: claim.mode,
      paths: claim.paths,
      ageSeconds: claim.ageSeconds,
      idleSeconds: claim.idleSeconds,
      matched,
    });
  }

  // A dirty failing file outside the current claim is evidence that the declared lane
  // is incomplete, not evidence of who made the edit. In an isolated worktree it may
  // be this agent; in a shared checkout it may be another process or a human.
  const dirtyOutsideYourClaim = failingPaths.filter(
    (suspect) => suspect.dirty && !coveredByMe(suspect.path),
  );

  let verdict: Verdict;
  if (foreignClaims.length > 0 && yours.length > 0) {
    verdict = "mixed-claims";
  } else if (foreignClaims.length > 0) {
    verdict = "claimed-by-other";
  } else if (yours.length > 0) {
    verdict = "claimed-by-you";
  } else if (dirtyOutsideYourClaim.length > 0) {
    verdict = "outside-your-claim";
  } else {
    verdict = "unattributed";
  }

  return {
    check,
    exitCode,
    failingPaths,
    yours,
    foreignClaims,
    dirtyOutsideYourClaim,
    verdict,
    yourClaims: mine.flatMap((claim) => claim.paths),
  };
}

export function renderAttribution(attribution: FailureAttribution): string {
  const lines: string[] = [];

  if (attribution.failingPaths.length > 0) {
    lines.push("Files named by the failure:");
    for (const suspect of attribution.failingPaths.slice(0, 8)) {
      const age =
        suspect.modifiedSecondsAgo === null
          ? ""
          : ` (modified ${describeAge(suspect.modifiedSecondsAgo)} ago${suspect.dirty ? ", uncommitted" : ""})`;
      lines.push(`  ${suspect.path}${age}`);
    }
    lines.push("");
  }

  switch (attribution.verdict) {
    case "claimed-by-other": {
      lines.push("Verdict: CLAIMED BY ANOTHER AGENT");
      for (const claim of attribution.foreignClaims) {
        const who = claim.workspace ? `${claim.agent} (${claim.workspace})` : claim.agent;
        lines.push(
          `  ${who} holds a ${claim.mode} claim on ${claim.paths.join(", ")} ` +
            `— started ${describeAge(claim.ageSeconds)} ago, last seen ${describeAge(claim.idleSeconds)} ago`,
        );
        if (claim.task) lines.push(`    task: ${claim.task}`);
        lines.push(`    covers: ${claim.matched.join(", ")}`);
      }
      lines.push("");
      lines.push("This is an ownership signal, not proof of who caused the failure.");
      lines.push("Do not edit the claimed paths without coordinating with that agent.");
      lines.push('You can retry with "muxtra build --wait 10m", or tell the human.');
      break;
    }
    case "mixed-claims": {
      lines.push("Verdict: MIXED CLAIMS");
      lines.push(`  Your write claim covers: ${attribution.yours.join(", ")}`);
      for (const claim of attribution.foreignClaims) {
        const who = claim.workspace ? `${claim.agent} (${claim.workspace})` : claim.agent;
        lines.push(`  ${who}'s write claim covers: ${claim.matched.join(", ")}`);
      }
      lines.push("");
      lines.push("The registry cannot assign responsibility while claims intersect this failure.");
      lines.push("Coordinate before editing any path claimed by another agent.");
      break;
    }
    case "outside-your-claim": {
      lines.push("Verdict: OUTSIDE YOUR CLAIM");
      lines.push("  These failing paths are uncommitted but outside your declared write claim:");
      for (const suspect of attribution.dirtyOutsideYourClaim.slice(0, 8)) {
        const age =
          suspect.modifiedSecondsAgo === null
            ? ""
            : ` — modified ${describeAge(suspect.modifiedSecondsAgo)} ago`;
        lines.push(`    ${suspect.path}${age}`);
      }
      lines.push("");
      lines.push(
        "The registry cannot tell who edited them. Inspect the diff, then widen your claim",
      );
      lines.push("or coordinate with the human before changing those paths.");
      break;
    }
    case "claimed-by-you": {
      lines.push("Verdict: CLAIMED BY YOU");
      lines.push(`  Failing files are inside your claim: ${attribution.yours.join(", ")}`);
      lines.push("  This is an ownership signal, not proof that your edit caused the failure.");
      break;
    }
    default: {
      lines.push("Verdict: UNATTRIBUTED");
      lines.push(
        attribution.yourClaims.length > 0
          ? `  Your claim covers ${attribution.yourClaims.join(", ")} and does not include the failing files.`
          : '  You hold no write claim. Run "muxtra claim --write <paths>" to declare your lane.',
      );
      break;
    }
  }

  return lines.join("\n");
}
