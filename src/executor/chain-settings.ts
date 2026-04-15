/**
 * Chain step types + pure template/behavior resolution helpers.
 *
 * Ported from settings.ts (chain-step domain) + the `normalizeSkillInput`
 * helper from skills.ts:519. Everything here is pure — the Effect
 * layer lives in executor/chain.ts which consumes these as building
 * blocks.
 *
 * Deliberately paralleling the legacy shape so executor/chain.ts can
 * call through without reshaping. Once Phase 8 lands AgentDirectory
 * overrides, the AgentConfig type will be promoted to the Schema-
 * backed shape; until then this uses a minimal structural interface.
 */
import * as path from "node:path";

// =============================================================================
// Chain step types (wire-compatible with settings.ts:37-70)
// =============================================================================

export interface SequentialStep {
	readonly agent: string;
	readonly task?: string;
	readonly cwd?: string;
	readonly output?: string | false;
	readonly reads?: ReadonlyArray<string> | false;
	readonly progress?: boolean;
	readonly skill?: string | ReadonlyArray<string> | false;
	readonly model?: string;
}

export interface ParallelTaskItem {
	readonly agent: string;
	readonly task?: string;
	readonly cwd?: string;
	readonly count?: number;
	readonly output?: string | false;
	readonly reads?: ReadonlyArray<string> | false;
	readonly progress?: boolean;
	readonly skill?: string | ReadonlyArray<string> | false;
	readonly model?: string;
}

export interface ParallelStep {
	readonly parallel: ReadonlyArray<ParallelTaskItem>;
	readonly concurrency?: number;
	readonly failFast?: boolean;
	readonly worktree?: boolean;
}

export interface TextStep {
	readonly text: string;
}

export type ChainStep = SequentialStep | ParallelStep | TextStep;

export interface MinimalAgentConfig {
	readonly name: string;
	readonly model?: string;
	readonly skills?: ReadonlyArray<string>;
	readonly output?: string;
	readonly defaultReads?: ReadonlyArray<string>;
	readonly defaultProgress?: boolean;
}

// =============================================================================
// Type guards + helpers
// =============================================================================

export function isParallelStep(step: ChainStep): step is ParallelStep {
	return "parallel" in step && Array.isArray((step as ParallelStep).parallel);
}

export function isTextStep(step: ChainStep): step is TextStep {
	return "text" in step && typeof (step as TextStep).text === "string";
}

export function getStepAgents(step: ChainStep): ReadonlyArray<string> {
	if (isParallelStep(step)) return step.parallel.map((t) => t.agent);
	if (isTextStep(step)) return [];
	return [step.agent];
}

/**
 * Normalize various shapes the `skill` field may arrive in:
 *   - true / undefined    -> undefined ("use default")
 *   - false               -> false ("disable")
 *   - string              -> split on commas; JSON-array strings decoded
 *   - string[]            -> dedupe, trim
 *
 * Ported from skills.ts:519.
 */
export function normalizeSkillInput(
	input: string | ReadonlyArray<string> | boolean | undefined,
): ReadonlyArray<string> | false | undefined {
	if (input === false) return false;
	if (input === true || input === undefined) return undefined;
	if (Array.isArray(input)) {
		return [...new Set(input.map((s) => s.trim()).filter((s) => s.length > 0))];
	}
	const trimmed = (input as string).trim();
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed)) return normalizeSkillInput(parsed as string[]);
		} catch {
			// Fall through to comma-split.
		}
	}
	return [...new Set(trimmed.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];
}

// =============================================================================
// Template resolution
// =============================================================================

export type ResolvedTemplates = ReadonlyArray<string | ReadonlyArray<string>>;

/**
 * Compute the per-step task template. Sequential step templates are
 * strings; parallel step templates are string arrays (one per task).
 * Default templates: `{task}` for step 0, `{previous}` for later
 * steps; parallel tasks default to `{previous}`.
 *
 * Substitution happens in `substituteChainTemplate` below.
 */
export function resolveChainTemplates(steps: ReadonlyArray<ChainStep>): ResolvedTemplates {
	return steps.map((step, i) => {
		if (isTextStep(step)) return "";
		if (isParallelStep(step)) {
			return step.parallel.map((task) => task.task ?? "{previous}");
		}
		const seq = step;
		if (seq.task) return seq.task;
		return i === 0 ? "{task}" : "{previous}";
	});
}

export function substituteChainTemplate(
	template: string,
	vars: { readonly task: string; readonly previous: string; readonly chainDir: string },
): string {
	return template
		.replaceAll("{task}", vars.task)
		.replaceAll("{previous}", vars.previous)
		.replaceAll("{chain_dir}", vars.chainDir);
}

// =============================================================================
// Behavior resolution
// =============================================================================

export interface ResolvedStepBehavior {
	readonly output: string | false;
	readonly reads: ReadonlyArray<string> | false;
	readonly progress: boolean;
	readonly skills: ReadonlyArray<string> | false;
	readonly model?: string;
}

export interface StepOverrides {
	readonly output?: string | false;
	readonly reads?: ReadonlyArray<string> | false;
	readonly progress?: boolean;
	readonly skills?: ReadonlyArray<string> | false;
	readonly model?: string;
}

/**
 * Step override > agent frontmatter > default. Ported from settings.ts:170.
 */
export function resolveStepBehavior(
	agentConfig: MinimalAgentConfig,
	stepOverrides: StepOverrides,
	chainSkills?: ReadonlyArray<string>,
): ResolvedStepBehavior {
	const output =
		stepOverrides.output !== undefined ? stepOverrides.output : (agentConfig.output ?? false);
	const reads =
		stepOverrides.reads !== undefined
			? stepOverrides.reads
			: (agentConfig.defaultReads ?? false);
	const progress =
		stepOverrides.progress !== undefined
			? stepOverrides.progress
			: (agentConfig.defaultProgress ?? false);

	let skills: ReadonlyArray<string> | false;
	if (stepOverrides.skills === false) {
		skills = false;
	} else if (stepOverrides.skills !== undefined) {
		const base = [...stepOverrides.skills];
		skills = chainSkills?.length ? [...new Set([...base, ...chainSkills])] : base;
	} else {
		const base = agentConfig.skills ? [...agentConfig.skills] : [];
		skills = chainSkills?.length ? [...new Set([...base, ...chainSkills])] : base;
	}

	const model = stepOverrides.model ?? agentConfig.model;
	return { output, reads, progress, skills, model };
}

/**
 * Parallel-step counterpart: resolves per-task behaviors + namespaces
 * relative output paths under `parallel-{stepIndex}/{taskIndex}-{agent}/`
 * to avoid collisions.
 *
 * Throws only in the "unknown agent" case — that's a configuration
 * error the caller detects before execution, not a runtime failure.
 * Ported from settings.ts:282.
 */
export function resolveParallelBehaviors(
	tasks: ReadonlyArray<ParallelTaskItem>,
	agentConfigs: ReadonlyArray<MinimalAgentConfig>,
	stepIndex: number,
	chainSkills?: ReadonlyArray<string>,
): ReadonlyArray<ResolvedStepBehavior> {
	return tasks.map((task, taskIndex) => {
		const config = agentConfigs.find((a) => a.name === task.agent);
		// Precondition: the caller (executor/chain.ts:runChain) pre-
		// validates every referenced agent before this helper runs and
		// emits a typed ChainStepFailed for unknown names. This throw
		// only fires if a direct caller bypasses that validation — it
		// becomes a programming error, surfaced as a fiber defect, not
		// a path through the Effect error channel.
		if (!config) throw new Error(`Unknown agent: ${task.agent} (caller must pre-validate)`);

		const subdir = path.join(`parallel-${stepIndex}`, `${taskIndex}-${task.agent}`);

		let output: string | false = false;
		if (task.output !== undefined) {
			if (task.output === false) {
				output = false;
			} else if (path.isAbsolute(task.output)) {
				output = task.output;
			} else {
				output = path.join(subdir, task.output);
			}
		} else if (config.output) {
			output = path.join(subdir, config.output);
		}

		const reads = task.reads !== undefined ? task.reads : (config.defaultReads ?? false);
		const progress =
			task.progress !== undefined ? task.progress : (config.defaultProgress ?? false);

		const taskSkillInput = normalizeSkillInput(task.skill);
		let skills: ReadonlyArray<string> | false;
		if (taskSkillInput === false) {
			skills = false;
		} else if (taskSkillInput !== undefined) {
			const base = [...taskSkillInput];
			skills = chainSkills?.length ? [...new Set([...base, ...chainSkills])] : base;
		} else {
			const base = config.skills ? [...config.skills] : [];
			skills = chainSkills?.length ? [...new Set([...base, ...chainSkills])] : base;
		}

		const model = task.model ?? config.model;
		return { output, reads, progress, skills, model };
	});
}

// =============================================================================
// Chain instruction injection
// =============================================================================

function resolveChainPath(filePath: string, chainDir: string): string {
	return path.isAbsolute(filePath) ? filePath : path.join(chainDir, filePath);
}

/**
 * Build the prefix + suffix strings that wrap a chain step's task.
 * The prefix tells the agent which files to read and where to write
 * its output; the suffix injects progress-file coordination and the
 * previous step's summary.
 *
 * Ported from settings.ts:227.
 */
export function buildChainInstructions(
	behavior: ResolvedStepBehavior,
	chainDir: string,
	isFirstProgressAgent: boolean,
	previousSummary?: string,
): { readonly prefix: string; readonly suffix: string } {
	const prefixParts: string[] = [];
	const suffixParts: string[] = [];

	if (behavior.reads && behavior.reads.length > 0) {
		const files = behavior.reads.map((f) => resolveChainPath(f, chainDir));
		prefixParts.push(`[Read from: ${files.join(", ")}]`);
	}

	if (behavior.output) {
		const outputPath = resolveChainPath(behavior.output, chainDir);
		prefixParts.push(`[Write to: ${outputPath}]`);
	}

	if (behavior.progress) {
		const progressPath = path.join(chainDir, "progress.md");
		suffixParts.push(
			isFirstProgressAgent
				? `Create and maintain progress at: ${progressPath}`
				: `Update progress at: ${progressPath}`,
		);
	}

	if (previousSummary && previousSummary.trim()) {
		suffixParts.push(`Previous step output:\n${previousSummary.trim()}`);
	}

	const prefix = prefixParts.length > 0 ? `${prefixParts.join("\n")}\n\n` : "";
	const suffix = suffixParts.length > 0 ? `\n\n---\n${suffixParts.join("\n")}` : "";

	return { prefix, suffix };
}
