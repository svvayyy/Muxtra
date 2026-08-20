import { normalizeStableAgent } from "../agents.js";
import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { table } from "../format.js";
import { laneFocus, normalizeTaskLane, type TaskLane } from "../lanes.js";
import { printJson } from "../protocol.js";
import { readState, setLaneDefault } from "../state.js";

export async function lanesCommand(cwd: string, asJson = false): Promise<void> {
  const { root, config } = await loadConfig(cwd);
  const local = (await readState(root)).laneDefaults ?? {};
  const lanes = (["design", "code"] as const).map((lane) => {
    const selection = local[lane] ?? config.lanes[lane];
    return {
      lane,
      agent: selection?.agent ?? null,
      model: selection?.model ?? null,
      source: local[lane] ? "local" : config.lanes[lane] ? "project" : "unconfigured",
      owns: laneFocus(lane),
    };
  });
  if (asJson) {
    printJson("lanes", { lanes });
    return;
  }
  console.log(
    table([
      ["LANE", "AGENT", "MODEL", "OWNS"],
      ...lanes.map((value) => [
        value.lane,
        value.agent ?? "not configured",
        value.model ?? "provider default",
        value.owns,
      ]),
    ]),
  );
  console.log("\nChange one with: muxtra lanes set design --agent claude --model <model>");
}

export async function setLaneCommand(
  cwd: string,
  rawLane: string,
  options: { agent: string; model?: string; clearModel?: boolean },
): Promise<void> {
  const lane = normalizeTaskLane(rawLane);
  const agent = normalizeStableAgent(options.agent);
  if (options.clearModel && options.model) {
    throw new CliError("Use either --model or --clear-model, not both.");
  }
  const loaded = await loadConfig(cwd);
  const local = (await readState(loaded.root)).laneDefaults ?? {};
  const previous = local[lane] ?? loaded.config.lanes[lane];
  const nextModel = options.clearModel ? undefined : options.model?.trim() || previous?.model;
  await setLaneDefault(loaded.root, lane, {
    agent,
    ...(nextModel ? { model: nextModel } : {}),
  });

  console.log(`✓ ${displayLane(lane)} lane updated`);
  console.log(`Agent: ${agent}`);
  console.log(`Model: ${nextModel ?? "provider default"}`);
  console.log(`Owns: ${laneFocus(lane)}`);
}

function displayLane(lane: TaskLane): string {
  return lane === "design" ? "Design" : "Code";
}
