import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gitCommonDir } from "./git.js";

export type ClaimMode = "read" | "write";

export interface ClaimRecord {
  id: string;
  agent: string;
  workspace: string | null;
  task: string | null;
  mode: ClaimMode;
  paths: string[];
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  ttlSeconds: number;
}

export interface ClaimView extends ClaimRecord {
  ageSeconds: number;
  idleSeconds: number;
  expired: boolean;
}

export interface ClaimOverlap {
  claim: ClaimView;
  patterns: string[];
}

export const DEFAULT_CLAIM_TTL_SECONDS = 1_800;
const CLAIM_ID = /^[a-z0-9][a-z0-9@-]{0,160}$/;

/**
 * Claims live beside the workspace state in the Git *common* directory, so every
 * worktree of a repository reads and writes the same registry. Agents in separate
 * worktrees cannot see each other's files; this is the one place they can see each
 * other's intent.
 */
export async function claimsDirectory(cwd: string): Promise<string> {
  const commonDir = await gitCommonDir(cwd);
  const current = path.join(commonDir, "muxtra", "claims");
  const legacy = path.join(commonDir, "parallel-agent", "claims");
  try {
    await stat(current);
    return current;
  } catch {
    try {
      await stat(legacy);
      return legacy;
    } catch {
      return current;
    }
  }
}

export function safeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "agent";
}

/** Two runs of the same agent in the same workspace are the same claimant. */
export function identityKey(agent: string, workspace: string | null): string {
  return workspace ? `${safeSlug(agent)}@${safeSlug(workspace)}` : safeSlug(agent);
}

export function newClaimId(agent: string, workspace: string | null): string {
  return `${identityKey(agent, workspace)}-${randomBytes(4).toString("hex")}`;
}

function decorate(record: ClaimRecord, now: number): ClaimView {
  const startedAt = Date.parse(record.startedAt);
  const heartbeatAt = Date.parse(record.heartbeatAt);
  const idleSeconds = Number.isNaN(heartbeatAt) ? 0 : Math.max(0, (now - heartbeatAt) / 1_000);
  return {
    ...record,
    ageSeconds: Number.isNaN(startedAt) ? 0 : Math.max(0, (now - startedAt) / 1_000),
    idleSeconds,
    expired: idleSeconds > record.ttlSeconds,
  };
}

function isClaimRecord(value: unknown, expectedFileName?: string): value is ClaimRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ClaimRecord>;
  return Boolean(
    typeof record.id === "string" &&
    CLAIM_ID.test(record.id) &&
    (!expectedFileName || expectedFileName === `${record.id}.json`) &&
    typeof record.agent === "string" &&
    record.agent.trim() &&
    (record.workspace === null || typeof record.workspace === "string") &&
    (record.task === null || typeof record.task === "string") &&
    (record.mode === "read" || record.mode === "write") &&
    Array.isArray(record.paths) &&
    record.paths.length > 0 &&
    record.paths.every((candidate) => typeof candidate === "string" && candidate.length > 0) &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    typeof record.startedAt === "string" &&
    !Number.isNaN(Date.parse(record.startedAt)) &&
    typeof record.heartbeatAt === "string" &&
    !Number.isNaN(Date.parse(record.heartbeatAt)) &&
    typeof record.ttlSeconds === "number" &&
    Number.isFinite(record.ttlSeconds) &&
    record.ttlSeconds > 0,
  );
}

/**
 * A half-written or corrupt claim is skipped rather than thrown on: a broken record
 * from one agent must never stop another agent from reading the registry.
 */
export async function readClaims(cwd: string, now = Date.now()): Promise<ClaimView[]> {
  const directory = await claimsDirectory(cwd);
  let entries: string[];

  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const claims: ClaimView[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const record: unknown = JSON.parse(await readFile(path.join(directory, entry), "utf8"));
      if (!isClaimRecord(record, entry)) continue;
      claims.push(decorate(record, now));
    } catch {
      continue;
    }
  }

  return claims.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export async function activeClaims(cwd: string, now = Date.now()): Promise<ClaimView[]> {
  return (await readClaims(cwd, now)).filter((claim) => !claim.expired);
}

/**
 * One file per claim, written atomically. Nothing does read-modify-write on a shared
 * document, so two agents registering at the same moment cannot lose each other's
 * claim — the failure mode that would make the whole registry untrustworthy.
 */
export async function saveClaim(cwd: string, record: ClaimRecord): Promise<void> {
  const recordId = record.id;
  if (!isClaimRecord(record)) throw new Error(`Invalid claim record: ${recordId}`);
  const directory = await claimsDirectory(cwd);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${record.id}.json`);
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

export async function removeClaim(cwd: string, id: string): Promise<void> {
  if (!CLAIM_ID.test(id)) throw new Error(`Invalid claim id: ${id}`);
  const directory = await claimsDirectory(cwd);
  await rm(path.join(directory, `${id}.json`), { force: true });
}

export async function claimsForIdentity(
  cwd: string,
  agent: string,
  workspace: string | null,
): Promise<ClaimView[]> {
  const key = identityKey(agent, workspace);
  return (await readClaims(cwd)).filter(
    (claim) => identityKey(claim.agent, claim.workspace) === key,
  );
}

/** Refreshes every active claim held by an identity. Expired claims stay expired and
 *  must be replaced explicitly rather than being revived by an unrelated command. */
export async function heartbeatIdentity(
  cwd: string,
  agent: string,
  workspace: string | null,
): Promise<number> {
  const claims = (await claimsForIdentity(cwd, agent, workspace)).filter((claim) => !claim.expired);
  const heartbeatAt = new Date().toISOString();
  for (const claim of claims) {
    const { ageSeconds, idleSeconds, expired, ...record } = claim;
    await saveClaim(cwd, { ...record, heartbeatAt });
  }
  return claims.length;
}

// MARK: - Path matching

export function normalizePattern(pattern: string): string {
  return pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
}

function globToRegExp(pattern: string): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          expression += "(?:.*/)?";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
      } else {
        expression += "[^/]*";
      }
      continue;
    }

    if (character === "?") {
      expression += "[^/]";
      continue;
    }

    expression += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`^${expression}$`);
}

export function patternMatchesPath(pattern: string, candidate: string): boolean {
  const normalizedPattern = normalizePattern(pattern);
  const target = normalizePattern(candidate);
  if (!normalizedPattern || !target) return false;

  // A bare path claims that file, and everything beneath it when it is a directory.
  if (!/[*?]/.test(normalizedPattern)) {
    return target === normalizedPattern || target.startsWith(`${normalizedPattern}/`);
  }

  return globToRegExp(normalizedPattern).test(target);
}

export function claimMatchesPath(claim: ClaimRecord, candidate: string): boolean {
  return claim.paths.some((pattern) => patternMatchesPath(pattern, candidate));
}

/** The fixed directory part of a pattern: `src/ui/**` -> `src/ui`. */
export function literalPrefix(pattern: string): string {
  const normalized = normalizePattern(pattern);
  const globIndex = normalized.search(/[*?]/);
  if (globIndex === -1) return normalized;
  const head = normalized.slice(0, globIndex);
  const lastSlash = head.lastIndexOf("/");
  return lastSlash === -1 ? "" : head.slice(0, lastSlash);
}

/**
 * Pattern-versus-pattern overlap, used at claim time when no concrete file list
 * exists yet. Deliberately conservative: it compares fixed prefixes, so it can report
 * an overlap that never materialises, but it will not stay silent about a real one.
 */
export function patternsOverlap(left: string, right: string): boolean {
  const a = literalPrefix(left);
  const b = literalPrefix(right);
  if (!a || !b) return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function findOverlaps(
  claims: ClaimView[],
  identity: { agent: string; workspace: string | null },
  patterns: string[],
  mode: ClaimMode,
): ClaimOverlap[] {
  const key = identityKey(identity.agent, identity.workspace);
  const overlaps: ClaimOverlap[] = [];

  for (const claim of claims) {
    if (claim.expired) continue;
    if (identityKey(claim.agent, claim.workspace) === key) continue;
    // Two readers never conflict.
    if (mode === "read" && claim.mode === "read") continue;

    const matched = patterns.filter((pattern) =>
      claim.paths.some((held) => patternsOverlap(pattern, held)),
    );
    if (matched.length > 0) overlaps.push({ claim, patterns: matched });
  }

  return overlaps;
}

export function describeAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h${Math.round((seconds % 3_600) / 60)}m`;
}
