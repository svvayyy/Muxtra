import { normalizeStableAgent, type StableAgent } from "./agents.js";
import type { ProjectConfig } from "./config.js";
import { CliError } from "./errors.js";

export type TaskLane = "design" | "code";

export interface LaneSelection {
  agent: StableAgent;
  model?: string;
}

export function normalizeTaskLane(value: string): TaskLane {
  if (value === "design" || value === "code") return value;
  throw new CliError(`Unknown lane "${value}". Use design or code.`);
}

export function resolveLaneSelection(
  config: ProjectConfig,
  lane: TaskLane,
  overrides: { agent?: string; model?: string } = {},
  localDefault?: LaneSelection,
): LaneSelection {
  const configured = localDefault ?? config.lanes[lane];
  const rawAgent = overrides.agent ?? configured?.agent;
  if (!rawAgent) {
    throw new CliError(
      `No ${lane} lane is configured. Run "muxtra lanes set ${lane} --agent ${lane === "design" ? "claude" : "codex"}" first.`,
    );
  }
  const model = overrides.model?.trim() || configured?.model;
  return {
    agent: normalizeStableAgent(rawAgent),
    ...(model ? { model } : {}),
  };
}

export function laneFocus(lane: TaskLane): string {
  return lane === "design"
    ? "UI, frontend behavior, visual polish, accessibility, and responsive states"
    : "backend logic, state, data, integrations, architecture, and tests";
}
