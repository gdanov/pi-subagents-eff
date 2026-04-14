/**
 * Chain execution — Effect-native port of chain-execution.ts.
 *
 * Core flow:
 *   chainDir = createChainDir(runId)
 *   for each step i:
 *     template = resolveChainTemplates(steps)[i]
 *     if sequential:
 *       task = substitute(template, {task, previous, chain_dir})
 *       task = buildChainInstructions.prefix + task + .suffix
 *       result = runSingle(...)
 *       previous = result.finalOutput
 *     else parallel:
 *       templates = string[]; substitute each
 *       results = runWithConcurrency(templates.map(... -> runSingle(...)), step.concurrency ?? 4)
 *       previous = aggregateParallelOutputs(results)
 *
 * Out of scope for Phase 6 (deferred):
 *   - ChainClarifyComponent TUI integration (Phase 9)
 *   - Worktree setup/diff for `worktree: true` parallel steps
 *     (follows once the orchestration is layered on GitSpawner)
 *   - Skills discovery + injection (Phase 8 AgentDirectory overrides)
 *   - recordRun() RunHistory call at the end (small follow-up)
 *   - share gist + outputPath post-processing
 *
 * Failure model:
 *   - Template substitution can't fail (legacy throws only on malformed
 *     input; we keep the substitute helper pure).
 *   - A step's runSingle can fail; when failFast (sequential default is
 *     fail-fast; parallel default is !failFast) we raise ChainStepFailed
 *     with stepIndex + agent + cause wrapped in.
 *   - Unknown agent at resolve-time throws (legacy parity) — this is a
 *     configuration error that should be caught before Phase 11 via
 *     Schema decoding at the tool boundary.
 */
import { Effect } from "effect";
import { ChainStepFailed } from "../errors.ts";
import type { AgentProgress } from "../domain/progress.ts";
import type { SingleResult } from "../domain/results.ts";
import { ArtifactStore } from "../services/ArtifactStore.ts";
import { FileSystem } from "../services/FileSystem.ts";
import { ModelResolver } from "../services/ModelResolver.ts";
import { PiSpawner } from "../services/PiSpawner.ts";
import { runSingle, type RunSingleAgent, type RunSingleOptions } from "./single.ts";

/** Services required by runSingle; runChain inherits the same set. */
type ChainServices = ArtifactStore | FileSystem | ModelResolver | PiSpawner;
import {
	buildChainInstructions,
	isParallelStep,
	resolveChainTemplates,
	resolveParallelBehaviors,
	resolveStepBehavior,
	substituteChainTemplate,
	type ChainStep,
	type MinimalAgentConfig,
	type ResolvedStepBehavior,
} from "./chain-settings.ts";
import {
	aggregateParallelOutputs,
	runWithConcurrency,
	type ParallelTaskResult,
} from "./parallel.ts";

// ============================================================================
// Input
// ============================================================================

export interface RunChainInput {
	readonly steps: ReadonlyArray<ChainStep>;
	readonly originalTask: string;
	readonly runId: string;
	readonly chainDir: string;
	readonly agents: ReadonlyArray<RunSingleAgent & MinimalAgentConfig>;
	readonly chainSkills?: ReadonlyArray<string>;
}

export interface RunChainOptions extends RunSingleOptions {
	/** Parallel-step concurrency when a step doesn't specify one (default 4). */
	readonly defaultConcurrency?: number;
}

export interface RunChainOutput {
	readonly results: ReadonlyArray<SingleResult>;
	readonly allProgress: ReadonlyArray<AgentProgress>;
	readonly chainAgents: ReadonlyArray<string>;
	readonly totalSteps: number;
	readonly finalOutput: string;
}

// ============================================================================
// runChain
// ============================================================================

export const runChain = (
	input: RunChainInput,
	options: RunChainOptions = {},
): Effect.Effect<RunChainOutput, ChainStepFailed, ChainServices> =>
	Effect.gen(function* () {
		const templates = resolveChainTemplates(input.steps);
		const agents = input.agents;
		const findAgent = (name: string): RunSingleAgent & MinimalAgentConfig => {
			const found = agents.find((a) => a.name === name);
			if (!found) throw new Error(`Unknown agent: ${name}`);
			return found;
		};

		const chainAgents: string[] = [];
		const allResults: SingleResult[] = [];
		const allProgress: AgentProgress[] = [];
		let previous = "";
		let firstProgressSeen = false;

		for (let i = 0; i < input.steps.length; i++) {
			const step = input.steps[i];
			if (!step) continue;
			const template = templates[i];

			if (isParallelStep(step)) {
				const parallelTemplates = template as ReadonlyArray<string>;
				const behaviors = resolveParallelBehaviors(
					step.parallel,
					agents,
					i,
					input.chainSkills,
				);

				const perTask = step.parallel.map((task, taskIndex) => ({ task, taskIndex }));
				const concurrency = step.concurrency ?? options.defaultConcurrency ?? 4;

				const results = yield* runWithConcurrency(perTask, concurrency, ({ task, taskIndex }) =>
					runOneParallelTask({
						task,
						taskIndex,
						template: parallelTemplates[taskIndex] ?? "{previous}",
						stepIndex: i,
						behavior: behaviors[taskIndex] as ResolvedStepBehavior,
						findAgent,
						chainDir: input.chainDir,
						originalTask: input.originalTask,
						previous,
						isFirstProgressAgent: !firstProgressSeen && (behaviors[taskIndex]?.progress ?? false),
						runId: input.runId,
						globalIndex: allResults.length + taskIndex,
						baseOptions: options,
						failFast: step.failFast ?? false,
					}),
				);

				for (const r of results) {
					allResults.push(r.result);
					if (r.result.progress) allProgress.push(r.result.progress);
					chainAgents.push(r.result.agent);
				}
				if (behaviors.some((b) => b.progress)) firstProgressSeen = true;

				const agg = aggregateParallelOutputs(
					results.map(
						(r): ParallelTaskResult => ({
							agent: r.result.agent,
							taskIndex: r.taskIndex,
							output: r.result.finalOutput ?? "",
							exitCode: r.result.exitCode,
							error: r.result.error,
							model: r.result.model,
							attemptedModels: r.result.attemptedModels,
						}),
					),
				);
				previous = agg;
				continue;
			}

			// Sequential
			const seqTemplate = template as string;
			const agent = findAgent(step.agent);
			const behavior = resolveStepBehavior(
				agent,
				{
					output: step.output,
					reads: step.reads,
					progress: step.progress,
					skills: (() => {
						const raw = step.skill;
						if (raw === undefined || raw === false) return raw;
						if (Array.isArray(raw)) return raw;
						return [raw as string];
					})(),
					model: step.model,
				},
				input.chainSkills,
			);

			const substituted = substituteChainTemplate(seqTemplate, {
				task: input.originalTask,
				previous,
				chainDir: input.chainDir,
			});
			const { prefix, suffix } = buildChainInstructions(
				behavior,
				input.chainDir,
				!firstProgressSeen && behavior.progress,
				previous,
			);
			const task = `${prefix}${substituted}${suffix}`;
			if (behavior.progress) firstProgressSeen = true;

			const result = yield* runSingle(
				{ agent, task, runId: input.runId, index: allResults.length },
				{
					...options,
					modelOverride: behavior.model ?? options.modelOverride,
					cwd: step.cwd ?? options.cwd,
				},
			).pipe(
				Effect.mapError((cause) => new ChainStepFailed({ stepIndex: i, agent: step.agent, cause })),
			);
			allResults.push(result);
			if (result.progress) allProgress.push(result.progress);
			chainAgents.push(step.agent);

			// Fail-fast on non-zero exit.
			if (result.exitCode !== 0) {
				return yield* Effect.fail(
					new ChainStepFailed({
						stepIndex: i,
						agent: step.agent,
						cause: result.error ?? `exit ${result.exitCode}`,
					}),
				);
			}

			previous = result.finalOutput ?? "";
		}

		return {
			results: allResults,
			allProgress,
			chainAgents,
			totalSteps: input.steps.length,
			finalOutput: previous,
		};
	});

// ============================================================================
// Parallel-task worker
// ============================================================================

interface ParallelTaskWorkerInput {
	readonly task: { readonly agent: string; readonly cwd?: string };
	readonly taskIndex: number;
	readonly template: string;
	readonly stepIndex: number;
	readonly behavior: ResolvedStepBehavior;
	readonly findAgent: (name: string) => RunSingleAgent & MinimalAgentConfig;
	readonly chainDir: string;
	readonly originalTask: string;
	readonly previous: string;
	readonly isFirstProgressAgent: boolean;
	readonly runId: string;
	readonly globalIndex: number;
	readonly baseOptions: RunSingleOptions;
	readonly failFast: boolean;
}

interface ParallelWorkerOutput {
	readonly result: SingleResult;
	readonly taskIndex: number;
}

function runOneParallelTask(
	w: ParallelTaskWorkerInput,
): Effect.Effect<ParallelWorkerOutput, ChainStepFailed, ChainServices> {
	const substituted = substituteChainTemplate(w.template, {
		task: w.originalTask,
		previous: w.previous,
		chainDir: w.chainDir,
	});
	const { prefix, suffix } = buildChainInstructions(
		w.behavior,
		w.chainDir,
		w.isFirstProgressAgent,
		w.previous,
	);
	const task = `${prefix}${substituted}${suffix}`;
	const agent = w.findAgent(w.task.agent);

	const run = runSingle(
		{ agent, task, runId: w.runId, index: w.globalIndex },
		{
			...w.baseOptions,
			modelOverride: w.behavior.model ?? w.baseOptions.modelOverride,
			cwd: w.task.cwd ?? w.baseOptions.cwd,
		},
	).pipe(
		Effect.map((result): ParallelWorkerOutput => ({ result, taskIndex: w.taskIndex })),
		Effect.mapError(
			(cause) => new ChainStepFailed({ stepIndex: w.stepIndex, agent: w.task.agent, cause }),
		),
	);

	// In best-effort mode (failFast=false) turn a failure into a synthetic
	// failed SingleResult so the whole step doesn't abort. In failFast mode
	// let the ChainStepFailed propagate — Effect.all aborts sibling tasks.
	return w.failFast
		? run
		: run.pipe(
				Effect.catchTag("ChainStepFailed", (err) =>
					Effect.succeed({
						result: {
							agent: w.task.agent,
							task,
							exitCode: 1,
							messages: [],
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							error: String(err.cause),
							finalOutput: "",
						} as SingleResult,
						taskIndex: w.taskIndex,
					}),
				),
			);
}
