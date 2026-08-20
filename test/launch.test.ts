import { describe, expect, it } from "vitest";
import { normalizeStableAgent } from "../src/agents.js";
import {
  buildAgentInstructions,
  buildClaudeLifecycleSettings,
  buildLaunchSpec,
} from "../src/commands/launch.js";
import type { ProjectConfig } from "../src/config.js";
import type { WorkspaceRecord } from "../src/state.js";

const workspace: WorkspaceRecord = {
  id: "workspace-id",
  name: "dashboard-polish",
  agent: "codex",
  branch: "agent/codex/dashboard-polish",
  baseRef: "refs/remotes/origin/main",
  baseSha: "0123456789abcdef",
  worktree: "/tmp/parallel-agent/dashboard-polish",
  managed: true,
  createdAt: "2026-08-10T00:00:00.000Z",
};

describe("agent launch adapters", () => {
  it("pins Codex to the managed worktree", () => {
    const specification = buildLaunchSpec("codex", workspace, "instructions", {
      PATH: "/test/bin",
    });

    expect(specification.command).toBe("codex");
    expect(specification.args).toEqual(["--cd", workspace.worktree, "instructions"]);
    expect(specification.environment.MUXTRA_WORKSPACE).toBe(workspace.name);
    expect(specification.environment.MUXTRA_WORKTREE).toBe(workspace.worktree);
  });

  it("launches Claude Code in the managed worktree", () => {
    const specification = buildLaunchSpec("claude", workspace, "instructions", {});

    expect(specification.command).toBe("claude");
    expect(specification.args.slice(0, 2)).toEqual(["--settings", expect.any(String)]);
    expect(specification.args.at(-1)).toBe("instructions");
    expect(specification.environment.MUXTRA_WORKTREE).toBe(workspace.worktree);
  });

  it("passes images into the full interactive Codex interface", () => {
    const specification = buildLaunchSpec(
      "codex",
      {
        ...workspace,
        attachments: ["/tmp/reference-one.png", "/tmp/reference-two.jpg"],
      },
      "instructions",
      {},
    );

    expect(specification.args).toEqual([
      "--image",
      "/tmp/reference-one.png",
      "/tmp/reference-two.jpg",
      "--cd",
      workspace.worktree,
      "instructions",
    ]);
  });

  it("grants the full interactive Claude interface access to image directories", () => {
    const specification = buildLaunchSpec(
      "claude",
      {
        ...workspace,
        attachments: ["/tmp/references/one.png", "/tmp/references/two.jpg"],
      },
      "instructions",
      {},
    );

    expect(specification.args.slice(0, 2)).toEqual(["--add-dir", "/tmp/references"]);
    expect(specification.args.slice(2, 4)).toEqual(["--settings", expect.any(String)]);
    expect(specification.args.at(-1)).toBe("instructions");
  });

  it("exports the selected launcher as the agent identity", () => {
    const specification = buildLaunchSpec("claude", workspace, "instructions", {});

    expect(workspace.agent).toBe("codex");
    expect(specification.environment.MUXTRA_AGENT).toBe("claude");
  });

  it("passes an exact model to each supported provider", () => {
    const codex = buildLaunchSpec(
      "codex",
      workspace,
      "instructions",
      {},
      "session",
      "gpt-code-model",
    );
    const claude = buildLaunchSpec(
      "claude",
      workspace,
      "instructions",
      {},
      "session",
      "claude-design-model",
    );

    expect(codex.args).toContain("gpt-code-model");
    expect(codex.args.slice(0, 2)).toEqual(["--model", "gpt-code-model"]);
    expect(claude.args.slice(0, 2)).toEqual(["--model", "claude-design-model"]);
    expect(codex.environment.MUXTRA_MODEL).toBe("gpt-code-model");
  });

  it("gives design and code lanes distinct ownership instructions", () => {
    const config = {
      project: { name: "Example" },
      repository: { default_branch: "main" },
      runtime: { copy_into_workspaces: [] },
      checks: [],
      lanes: {},
      git: {
        branch_prefix: "agent",
        agents_may_commit: true,
        agents_may_push_feature_branches: true,
        direct_push_to_main: false,
        force_push: false,
      },
      providers: {},
      production: { requires_approval: true, deploy_by_merging: true },
      version: 1,
    } as ProjectConfig;

    const design = buildAgentInstructions(
      config,
      { ...workspace, lane: "design", peerWorkspaces: ["settings-code"] },
      "claude",
      "Build settings",
      "opus",
    );
    const code = buildAgentInstructions(
      config,
      { ...workspace, lane: "code", peerWorkspaces: ["settings-design"] },
      "codex",
      "Build settings",
      "gpt-code",
    );

    expect(design).toContain("Own the UI, frontend behavior");
    expect(design).toContain("Paired workspace: settings-code");
    expect(code).toContain("Own backend logic, application state");
    expect(code).toContain("Paired workspace: settings-design");
  });

  it("adds session-scoped Claude lifecycle hooks without replacing user settings", () => {
    const settings = buildClaudeLifecycleSettings() as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };

    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain("--state working");
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("--state waiting");
    expect(settings.hooks.Notification[0].hooks[0].command).toContain("--state needs_input");
  });

  it("accepts stable CLI aliases and rejects experimental adapters", () => {
    expect(normalizeStableAgent("Claude Code")).toBe("claude");
    expect(normalizeStableAgent("codex-cli")).toBe("codex");
    expect(() => normalizeStableAgent("openclaw")).toThrow(/Supported launchers: claude, codex/);
  });

  it("starts portable instructions with the activity handshake", () => {
    const config = {
      project: { name: "Example" },
      repository: { default_branch: "main" },
      runtime: { copy_into_workspaces: [] },
      checks: [],
      git: {
        branch_prefix: "agent",
        agents_may_commit: true,
        agents_may_push_feature_branches: true,
        direct_push_to_main: false,
        force_push: false,
      },
      providers: {},
      production: { requires_approval: true, deploy_by_merging: true },
      version: 1,
    } as ProjectConfig;

    const instructions = buildAgentInstructions(config, workspace, "codex", "Do the work");
    expect(instructions).toContain("muxtra attach dashboard-polish --agent codex");
    expect(instructions).toContain("without reading this conversation");
  });

  it("names attached images in the agent instructions", () => {
    const config = {
      project: { name: "Example" },
      repository: { default_branch: "main" },
      runtime: { copy_into_workspaces: [] },
      checks: [],
      git: {
        branch_prefix: "agent",
        agents_may_commit: true,
        agents_may_push_feature_branches: true,
        direct_push_to_main: false,
        force_push: false,
      },
      providers: {},
      production: { requires_approval: true, deploy_by_merging: true },
      version: 1,
    } as ProjectConfig;
    const instructions = buildAgentInstructions(
      config,
      { ...workspace, attachments: ["/tmp/reference.png"] },
      "claude",
      "Match the reference",
    );

    expect(instructions).toContain("Attached images:");
    expect(instructions).toContain("/tmp/reference.png");
    expect(instructions).toContain("Inspect these images");
  });
});
