import { Effect } from "effect";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type AgentData = {
	id: string;
	name: string;
	source: "user" | "project";
	description: string;
	chain?: object;
	maxConcurrentSubagents?: number;
	maxDepth?: number;
};

export type ModelInfo = {
	id: string;
	name: string;
	provider: string;
};

export type SkillInfo = {
	id: string;
	name: string;
	description: string;
};

export type ManagerResult = {
	action: "cancel" | "save";
	data?: AgentData;
};

export async function showAgentManager(
	_ctx: ExtensionContext,
	_agentData: AgentData,
	_models: ModelInfo[],
	_skills: SkillInfo[],
): Promise<ManagerResult> {
	throw new Error("showAgentManager not yet implemented - Phase 11 will wire this up");
}

export function showAgentManagerEffect(
	ctx: ExtensionContext,
	agentData: AgentData,
	models: ModelInfo[],
	skills: SkillInfo[],
): Effect.Effect<ManagerResult, Error> {
	return Effect.tryPromise({
		try: () => showAgentManager(ctx, agentData, models, skills),
		catch: (e) => new Error(String(e)),
	});
}
