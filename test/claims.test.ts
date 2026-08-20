import { describe, expect, it } from "vitest";
import { findOverlaps, literalPrefix, patternMatchesPath, patternsOverlap } from "../src/claims.js";
import type { ClaimView } from "../src/claims.js";
import { extractPaths } from "../src/attribution.js";

describe("path patterns", () => {
  it("matches globstars against nested files", () => {
    expect(patternMatchesPath("ExampleApp/UI/**", "ExampleApp/UI/Components/MathText.swift")).toBe(
      true,
    );
    expect(patternMatchesPath("ExampleApp/UI/**", "ExampleApp/Core/Models/Thing.swift")).toBe(
      false,
    );
  });

  it("treats a bare directory as claiming everything beneath it", () => {
    expect(patternMatchesPath("src/core", "src/core/thing.ts")).toBe(true);
    expect(patternMatchesPath("src/core", "src/core")).toBe(true);
    expect(patternMatchesPath("src/core", "src/corridor/thing.ts")).toBe(false);
  });

  it("keeps single stars inside one path segment", () => {
    expect(patternMatchesPath("src/*.ts", "src/index.ts")).toBe(true);
    expect(patternMatchesPath("src/*.ts", "src/nested/index.ts")).toBe(false);
    expect(patternMatchesPath("**/*.swift", "a/b/c/File.swift")).toBe(true);
  });

  it("reduces a pattern to its fixed prefix", () => {
    expect(literalPrefix("ExampleApp/UI/**")).toBe("ExampleApp/UI");
    expect(literalPrefix("src/*.ts")).toBe("src");
    expect(literalPrefix("**/*.ts")).toBe("");
    expect(literalPrefix("src/core/thing.ts")).toBe("src/core/thing.ts");
  });

  it("detects overlapping claims without concrete file lists", () => {
    expect(patternsOverlap("src/ui/**", "src/ui/components/**")).toBe(true);
    expect(patternsOverlap("src/ui/**", "src/core/**")).toBe(false);
    expect(patternsOverlap("src/core/thing.ts", "src/core/**")).toBe(true);
    // An unanchored pattern could hit anything, so it is reported rather than missed.
    expect(patternsOverlap("**/*.ts", "src/core/**")).toBe(true);
  });
});

function claim(overrides: Partial<ClaimView>): ClaimView {
  return {
    id: "bob-1234",
    agent: "bob",
    workspace: null,
    task: null,
    mode: "write",
    paths: ["src/core/**"],
    pid: 1,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    ttlSeconds: 1800,
    ageSeconds: 10,
    idleSeconds: 1,
    expired: false,
    ...overrides,
  };
}

describe("overlap detection", () => {
  const identity = { agent: "claude", workspace: null };

  it("ignores your own claim", () => {
    const claims = [claim({ agent: "claude", paths: ["src/ui/**"] })];
    expect(findOverlaps(claims, identity, ["src/ui/**"], "write")).toHaveLength(0);
  });

  it("ignores expired claims", () => {
    const claims = [claim({ paths: ["src/ui/**"], expired: true })];
    expect(findOverlaps(claims, identity, ["src/ui/**"], "write")).toHaveLength(0);
  });

  it("lets two readers share a path", () => {
    const claims = [claim({ mode: "read", paths: ["src/ui/**"] })];
    expect(findOverlaps(claims, identity, ["src/ui/**"], "read")).toHaveLength(0);
    expect(findOverlaps(claims, identity, ["src/ui/**"], "write")).toHaveLength(1);
  });

  it("reports a foreign write claim over the same tree", () => {
    const claims = [claim({ paths: ["src/core/**"] })];
    const overlaps = findOverlaps(claims, identity, ["src/core/models/**"], "write");
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].claim.agent).toBe("bob");
  });
});

describe("reading file names out of check output", () => {
  const root = "/repo";

  it("reads clang and swift style references", () => {
    const output = "/repo/Sources/Core/Suite.swift:78:9: error: switch must be exhaustive";
    expect(extractPaths(output, root)).toEqual(["Sources/Core/Suite.swift"]);
  });

  it("reads tsc style references", () => {
    const output = "src/core/thing.ts(12,3): error TS2345: Argument of type";
    expect(extractPaths(output, root)).toEqual(["src/core/thing.ts"]);
  });

  it("ignores paths outside the repository and URLs", () => {
    const output = [
      "/elsewhere/other.ts:3:1: error",
      "see https://example.com/docs.html:2 for details",
    ].join("\n");
    expect(extractPaths(output, root)).toEqual([]);
  });

  it("deduplicates repeated references", () => {
    const output = ["src/a.ts:1:1: error", "src/a.ts:9:2: error", "src/b.ts:4:1: error"].join("\n");
    expect(extractPaths(output, root)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
