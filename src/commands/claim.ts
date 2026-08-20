import path from "node:path";

import {
  DEFAULT_CLAIM_TTL_SECONDS,
  type ClaimMode,
  type ClaimRecord,
  claimsForIdentity,
  describeAge,
  findOverlaps,
  identityKey,
  newClaimId,
  normalizePattern,
  readClaims,
  removeClaim,
  saveClaim,
} from "../claims.js";
import { CliError } from "../errors.js";
import { table } from "../format.js";
import { gitRoot } from "../git.js";
import { resolveIdentity } from "../identity.js";
import { printJson } from "../protocol.js";

export interface ClaimOptions {
  write?: boolean;
  read?: boolean;
  task?: string;
  agent?: string;
  ttl?: string;
  json?: boolean;
  failOnConflict?: boolean;
  allowSpacePaths?: boolean;
}

export async function claimCommand(
  cwd: string,
  paths: string[],
  options: ClaimOptions,
): Promise<void> {
  const root = await gitRoot(cwd);
  const patterns = paths.map(normalizePattern).filter(Boolean);

  if (patterns.length === 0) {
    throw new CliError('Name at least one path or glob, for example: muxtra claim "src/ui/**"');
  }
  if (options.read && options.write) {
    throw new CliError("Choose either --read or --write, not both.");
  }
  for (const pattern of patterns) {
    if (/\s/.test(pattern) && !options.allowSpacePaths) {
      throw new CliError(
        `Claim path contains whitespace and may combine multiple paths: ${pattern}. ` +
          "Pass each path as a separate quoted argument, or use --allow-space-paths for an intentional path containing spaces.",
      );
    }
    const segments = pattern.split("/");
    if (
      path.posix.isAbsolute(pattern) ||
      path.win32.isAbsolute(pattern) ||
      segments.includes("..")
    ) {
      throw new CliError(`Claim paths must stay inside the repository: ${pattern}`);
    }
  }

  const identity = await resolveIdentity(root, options.agent);
  if (identity.source === "unknown" && !options.agent) {
    throw new CliError(
      "Could not tell which agent is claiming. Pass --agent <name>, or set MUXTRA_AGENT. " +
        'Agents started by "muxtra launch" are identified automatically.',
    );
  }

  const mode: ClaimMode = options.read ? "read" : "write";
  const ttlSeconds = options.ttl ? Number(options.ttl) * 60 : DEFAULT_CLAIM_TTL_SECONDS;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new CliError("--ttl expects a number of minutes.");
  }

  const now = new Date().toISOString();
  const record: ClaimRecord = {
    id: newClaimId(identity.agent, identity.workspace),
    agent: identity.agent,
    workspace: identity.workspace,
    task: options.task?.trim() || null,
    mode,
    paths: patterns,
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    ttlSeconds,
  };

  const claimsBefore = await readClaims(root);
  const overlapsBefore = findOverlaps(claimsBefore, identity, patterns, mode);
  if (options.failOnConflict && overlapsBefore.length > 0) {
    throw new CliError("Overlapping claim held by another agent; your claim was not changed.", 2);
  }

  const existing = await claimsForIdentity(root, identity.agent, identity.workspace);
  for (const claim of existing) {
    await removeClaim(root, claim.id);
  }
  await saveClaim(root, record);

  const claims = await readClaims(root);
  const overlaps = findOverlaps(claims, identity, patterns, mode);

  if (options.json) {
    printJson("claim", { claim: record, overlaps });
  } else {
    console.log(`Claimed ${mode}: ${patterns.join(", ")}`);
    console.log(`Agent: ${identity.agent}${identity.workspace ? ` (${identity.workspace})` : ""}`);
    console.log(`Expires after ${Math.round(ttlSeconds / 60)}m without activity.`);

    const others = claims.filter(
      (claim) =>
        identityKey(claim.agent, claim.workspace) !==
          identityKey(identity.agent, identity.workspace) && !claim.expired,
    );

    if (overlaps.length === 0) {
      console.log(
        others.length === 0
          ? "\nNo other agents are active."
          : `\n${others.length} other agent(s) active, none overlapping.`,
      );
    } else {
      console.log("\nOVERLAP — another agent has claimed paths that intersect yours:");
      for (const overlap of overlaps) {
        const who = overlap.claim.workspace
          ? `${overlap.claim.agent} (${overlap.claim.workspace})`
          : overlap.claim.agent;
        console.log(
          `  ${who}  ${overlap.claim.mode}  ${overlap.claim.paths.join(", ")}  ` +
            `(${describeAge(overlap.claim.ageSeconds)} old)`,
        );
        if (overlap.claim.task) console.log(`    task: ${overlap.claim.task}`);
      }
      console.log("\nClaims do not block. Coordinate, narrow your paths, or ask the human.");
    }
  }
}

export async function releaseCommand(
  cwd: string,
  options: { agent?: string; all?: boolean },
): Promise<void> {
  const root = await gitRoot(cwd);

  if (options.all) {
    const claims = await readClaims(root);
    for (const claim of claims) await removeClaim(root, claim.id);
    console.log(`Released ${claims.length} claim(s).`);
    return;
  }

  const identity = await resolveIdentity(root, options.agent);
  const claims = await claimsForIdentity(root, identity.agent, identity.workspace);
  for (const claim of claims) await removeClaim(root, claim.id);
  console.log(`Released ${claims.length} claim(s) for ${identity.agent}.`);
}

export async function whoCommand(cwd: string, asJson: boolean): Promise<void> {
  const root = await gitRoot(cwd);
  const claims = await readClaims(root);

  if (asJson) {
    printJson("who", { claims });
    return;
  }

  if (claims.length === 0) {
    console.log("No agents have claimed anything in this repository.");
    return;
  }

  const rows = [["AGENT", "WORKSPACE", "MODE", "PATHS", "AGE", "SEEN", "STATE"]];
  for (const claim of claims) {
    rows.push([
      claim.agent,
      claim.workspace ?? "-",
      claim.mode,
      claim.paths.join(", "),
      describeAge(claim.ageSeconds),
      describeAge(claim.idleSeconds),
      claim.expired ? "expired" : "active",
    ]);
  }
  console.log(table(rows));

  const expired = claims.filter((claim) => claim.expired);
  if (expired.length > 0) {
    console.log(
      `\n${expired.length} expired claim(s) left by agents that stopped without releasing. ` +
        'Clear them with "muxtra release --all".',
    );
  }

  const tasks = claims.filter((claim) => claim.task && !claim.expired);
  if (tasks.length > 0) {
    console.log("");
    for (const claim of tasks) console.log(`${claim.agent}: ${claim.task}`);
  }
}
