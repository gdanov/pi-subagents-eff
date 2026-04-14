/**
 * Parallel execution helpers — Effect-native port of parallel-utils.ts.
 *
 * The legacy `mapConcurrent` is replaced by `Effect.all(items, { concurrency })`.
 * `aggregateParallelOutputs` and `flattenSteps` remain pure helpers.
 *
 * Scope for Phase 6: the fan-out primitive + output aggregation only.
 * Worktree orchestration (createWorktrees / diffWorktrees / setup
 * hooks / synthetic paths) is a separate concern that layers on top
 * of this — it can land in a follow-up once Phase 8 wires GitSpawner
 * into the executor entry point.
 */
import { Effect } from "effect";
import { MAX_PARALLEL_CONCURRENCY } from "../domain/constants.ts";

// ============================================================================
// Task-result shape (wire-compatible with parallel-utils.ts:81)
// ============================================================================

export interface ParallelTaskResult {
	readonly agent: string;
	readonly taskIndex?: number;
	readonly output: string;
	readonly exitCode: number | null;
	readonly error?: string;
	readonly model?: string;
	readonly attemptedModels?: ReadonlyArray<string>;
	readonly outputTargetPath?: string;
	readonly outputTargetExists?: boolean;
}

// ============================================================================
// Fan-out via Effect.all { concurrency }
// ============================================================================

/**
 * Run `items` through `fn` with bounded concurrency, preserving result order.
 *
 * Replaces parallel-utils.ts:mapConcurrent. The legacy helper included a
 * 150-ms-per-worker stagger to avoid file-lock contention when multiple
 * subagents read shared config. That's intentionally dropped here —
 * verify with the worktree tests before re-adding (the plan called
 * this out as a candidate for removal).
 */
export const runWithConcurrency = <A, B, E, R>(
	items: ReadonlyArray<A>,
	concurrency: number,
	fn: (item: A, index: number) => Effect.Effect<B, E, R>,
): Effect.Effect<ReadonlyArray<B>, E, R> => {
	const safeConcurrency = Math.max(1, Math.floor(concurrency) || 1);
	const effects = items.map((item, index) => fn(item, index));
	return Effect.all(effects, { concurrency: safeConcurrency });
};

// ============================================================================
// Output aggregation (pure, wire-compatible with parallel-utils.ts:94)
// ============================================================================

export function aggregateParallelOutputs(
	results: ReadonlyArray<ParallelTaskResult>,
	headerFormat: (index: number, agent: string) => string = (i, agent) =>
		`=== Parallel Task ${i + 1} (${agent}) ===`,
): string {
	return results
		.map((r, i) => {
			const header = headerFormat(r.taskIndex ?? i, r.agent);
			const hasOutput = Boolean(r.output?.trim());
			const status = statusLine(r, hasOutput);
			const body = status ? (hasOutput ? `${status}\n${r.output}` : status) : r.output;
			return `${header}\n${body}`;
		})
		.join("\n\n");
}

function statusLine(r: ParallelTaskResult, hasOutput: boolean): string {
	if (r.exitCode === -1) return "⏭️ SKIPPED";
	if (r.exitCode !== 0 && r.exitCode !== null) {
		return `⚠️ FAILED (exit code ${r.exitCode})${r.error ? `: ${r.error}` : ""}`;
	}
	if (r.error) return `⚠️ WARNING: ${r.error}`;
	if (!hasOutput && r.outputTargetPath && r.outputTargetExists === false) {
		return `⚠️ EMPTY OUTPUT (expected output file missing: ${r.outputTargetPath})`;
	}
	if (!hasOutput && !r.outputTargetPath) return "⚠️ EMPTY OUTPUT (no textual response returned)";
	return "";
}

// ============================================================================
// Step flattening (pure, wire-compatible with parallel-utils.ts:39)
// ============================================================================

export interface RunnerSubagentStep {
	readonly agent: string;
	readonly task: string;
	readonly cwd?: string;
	readonly model?: string;
	readonly modelCandidates?: ReadonlyArray<string>;
	readonly tools?: ReadonlyArray<string>;
	readonly extensions?: ReadonlyArray<string>;
	readonly mcpDirectTools?: ReadonlyArray<string>;
	readonly systemPrompt?: string | null;
	readonly skills?: ReadonlyArray<string>;
	readonly outputPath?: string;
	readonly sessionFile?: string;
	readonly maxSubagentDepth?: number;
}

export interface ParallelStepGroup {
	readonly parallel: ReadonlyArray<RunnerSubagentStep>;
	readonly concurrency?: number;
	readonly failFast?: boolean;
	readonly worktree?: boolean;
}

export type RunnerStep = RunnerSubagentStep | ParallelStepGroup;

export function isRunnerParallelGroup(step: RunnerStep): step is ParallelStepGroup {
	return "parallel" in step && Array.isArray((step as ParallelStepGroup).parallel);
}

export function flattenSteps(steps: ReadonlyArray<RunnerStep>): ReadonlyArray<RunnerSubagentStep> {
	const flat: RunnerSubagentStep[] = [];
	for (const step of steps) {
		if (isRunnerParallelGroup(step)) for (const t of step.parallel) flat.push(t);
		else flat.push(step);
	}
	return flat;
}

export { MAX_PARALLEL_CONCURRENCY };
