import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { resolveLaneSelection } from "../lanes.js";
import { readState, updateWorkspace, type WorkspaceRecord } from "../state.js";
import { removeCommand } from "./remove.js";
import { startCommand } from "./start.js";

export interface TeamOptions {
  designAgent?: string;
  designModel?: string;
  codeAgent?: string;
  codeModel?: string;
  base?: string;
  fetch?: boolean;
  images?: string[];
}

/** Creates two coordinated but isolated tasks. The user launches each in its own terminal. */
export async function teamCommand(
  cwd: string,
  prompt: string,
  options: TeamOptions,
): Promise<{ design: WorkspaceRecord; code: WorkspaceRecord }> {
  const { root, config } = await loadConfig(cwd);
  const localDefaults = (await readState(root)).laneDefaults;
  const designSelection = resolveLaneSelection(
    config,
    "design",
    {
      agent: options.designAgent,
      model: options.designModel,
    },
    localDefaults?.design,
  );
  const codeSelection = resolveLaneSelection(
    config,
    "code",
    {
      agent: options.codeAgent,
      model: options.codeModel,
    },
    localDefaults?.code,
  );
  const teamId = randomUUID();

  const design = await startCommand(root, prompt, {
    ...designSelection,
    lane: "design",
    base: options.base,
    fetch: options.fetch,
    launch: false,
    images: options.images,
    teamId,
  });
  let code: WorkspaceRecord;
  try {
    code = await startCommand(root, prompt, {
      ...codeSelection,
      lane: "code",
      base: options.base,
      fetch: false,
      launch: false,
      images: options.images,
      teamId,
      peerWorkspaces: [design.name],
      skipCleanCheck: true,
    });
  } catch (error) {
    await removeCommand(root, design.name).catch(() => undefined);
    throw error;
  }
  const linkedDesign = await updateWorkspace(root, design.id, (workspace) => ({
    ...workspace,
    peerWorkspaces: [code.name],
  }));

  console.log("\n✓ Design + code team ready");
  console.log("Open two terminals and run:");
  console.log(`  muxtra launch ${linkedDesign.name}`);
  console.log(`  muxtra launch ${code.name}`);
  console.log("\nWhen both lanes are verified, combine them with:");
  console.log(`  muxtra combine ${linkedDesign.name} ${code.name}`);
  return { design: linkedDesign, code };
}
