import { Effect } from "effect";
import type { SubagentParams } from "../schema/subagent-params.ts";
import type { SingleResult } from "../domain/results.ts";
import type { AgentProgress } from "../domain/progress.ts";
import { runSingle, type RunSingleAgent, type RunSingleOptions } from "./single.ts";
import { runChain } from "./chain.ts";
import { handleManagementAction, type ManagementToolResult } from "./management.ts";
import { checkSubagentDepthEffect } from "../domain/depth.ts";
import { isParallelStep, isTextStep, type ChainStep } from "./chain-settings.ts";

export interface ExecutorOutput {
	readonly result: SingleResult | ReadonlyArray<SingleResult>;
	readonly progress?: ReadonlyArray<AgentProgress>;
	readonly management?: ManagementToolResult;
}

export interface ExecutorOptions extends RunSingleOptions {
	readonly chainDir?: string;
	readonly agents: ReadonlyArray<RunSingleAgent>;
	readonly chainSteps?: ReadonlyArray<ChainStep>;
	readonly chainSkills?: ReadonlyArray<string>;
	readonly defaultConcurrency?: number;
}

export function executeSubagent(
	params: SubagentParams,
	options: ExecutorOptions,
) {
	return Effect.gen(function* () {
		const cwd = params.cwd ?? process.cwd();

		if (params.action) {
			const management = yield* handleManagementAction(
				{
					action: params.action as "list" | "get" | "create" | "update" | "delete",
					agent: params.agent,
					chainName: params.chainName,
					agentScope: params.agentScope,
					config: params.config,
				},
				{ cwd },
			);
			return { result: {} as SingleResult, management };
		}

		if (params.tasks && params.tasks.length > 0) {
			yield* checkSubagentDepthEffect();
			const runId = crypto.randomUUID();
			const allResults: SingleResult[] = [];
			for (let i = 0; i < params.tasks.length; i++) {
				const task = params.tasks[i]!;
				const agent = options.agents.find((a) => a.name === task.agent);
				if (!agent) throw new Error(`Agent not found: ${task.agent}`);
				const result = yield* runSingle(
					{ agent, task: task.task, runId, index: i },
					{
						...options,
						cwd: task.cwd ?? options.cwd,
						modelOverride: task.model ?? options.modelOverride,
					},
				);
				allResults.push(result);
			}
			return { result: allResults };
		}

		if (params.chain && params.chain.length > 0) {
			yield* checkSubagentDepthEffect();
			const runId = crypto.randomUUID();
			const chainDir = params.chainDir ?? options.chainDir ?? "";

			const chainAgents: RunSingleAgent[] = [];
			for (let i = 0; i < params.chain.length; i++) {
				const step = params.chain[i] as ChainStep;
				if (isTextStep(step) || !step) continue;
				if (isParallelStep(step)) {
					for (const t of step.parallel) {
						if (!chainAgents.some((a) => a.name === t.agent)) {
							const found = options.agents.find((a) => a.name === t.agent);
							if (found) chainAgents.push(found);
						}
					}
				} else {
					if (!chainAgents.some((a) => a.name === step.agent)) {
						const found = options.agents.find((a) => a.name === step.agent);
						if (found) chainAgents.push(found);
					}
				}
			}

			const chainSkills = params.skill
				? Array.isArray(params.skill)
					? params.skill
					: [params.skill]
				: options.chainSkills;

			const output = yield* runChain(
				{
					steps: params.chain as ReadonlyArray<ChainStep>,
					originalTask: params.task ?? "",
					runId,
					chainDir,
					agents: chainAgents.length > 0 ? chainAgents : options.agents,
					chainSkills,
				},
				options,
			);
			return {
				result: output.results,
				progress: output.allProgress,
			};
		}

		yield* checkSubagentDepthEffect();
		const runId = crypto.randomUUID();
		const agent = options.agents.find((a) => a.name === params.agent);
		if (!agent) throw new Error(`Agent not found: ${params.agent}`);
		const result = yield* runSingle(
			{ agent, task: params.task ?? "", runId },
			options,
		);
		return { result };
	});
}
