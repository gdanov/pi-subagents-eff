/**
 * Effect Schema for chain-step types.
 *
 * Replaces the SequentialStepSchema, ParallelTaskSchema, ParallelStepSchema,
 * and ChainItem definitions in schemas.ts. ChainItem becomes a real
 * Schema.Union(SequentialStep, ParallelStep) — the legacy `Type.Any()`
 * workaround at schemas.ts:58 was for Google API anyOf-compat at the
 * tool-registration boundary; the typebox-bridge handles that without
 * weakening the runtime decode.
 *
 * The two members are discriminated structurally by the presence of the
 * `parallel` array (matches the on-disk shape). For decode performance
 * we don't promote this to a tagged union — the legacy code's shape is
 * already in the wild.
 */
import { Schema } from "effect";
import { OutputOverrideSchema, ReadsOverrideSchema, SkillOverrideSchema } from "./common.ts";

// ============================================================================
// SequentialStep — single agent in a chain pipeline
// ============================================================================

export const SequentialStepSchema = Schema.Struct({
	agent: Schema.String,
	task: Schema.optional(
		Schema.String.annotate({
			description:
				"Task template with variables: {task}=original request, {previous}=prior step's text response, {chain_dir}=shared folder. Required for first step, defaults to '{previous}' for subsequent steps.",
		}),
	),
	cwd: Schema.optional(Schema.String),
	output: Schema.optional(OutputOverrideSchema),
	reads: Schema.optional(ReadsOverrideSchema),
	progress: Schema.optional(
		Schema.Boolean.annotate({
			description: "Enable progress.md tracking in {chain_dir}",
		}),
	),
	skill: Schema.optional(SkillOverrideSchema),
	model: Schema.optional(
		Schema.String.annotate({ description: "Override model for this step" }),
	),
}).annotate({ identifier: "SequentialStep" });

export type SequentialStep = typeof SequentialStepSchema.Type;

// ============================================================================
// ParallelTask — one task inside a parallel step
// ============================================================================

export const ParallelTaskSchema = Schema.Struct({
	agent: Schema.String,
	task: Schema.optional(
		Schema.String.annotate({
			description:
				"Task template with {task}, {previous}, {chain_dir} variables. Defaults to {previous}.",
		}),
	),
	cwd: Schema.optional(Schema.String),
	count: Schema.optional(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
			description: "Repeat this parallel task N times with the same settings.",
		}),
	),
	output: Schema.optional(OutputOverrideSchema),
	reads: Schema.optional(ReadsOverrideSchema),
	progress: Schema.optional(
		Schema.Boolean.annotate({
			description: "Enable progress.md tracking in {chain_dir}",
		}),
	),
	skill: Schema.optional(SkillOverrideSchema),
	model: Schema.optional(
		Schema.String.annotate({ description: "Override model for this task" }),
	),
}).annotate({ identifier: "ParallelTask" });

export type ParallelTask = typeof ParallelTaskSchema.Type;

// ============================================================================
// ParallelStep — multiple agents running concurrently within a chain step
// ============================================================================

export const ParallelStepSchema = Schema.Struct({
	parallel: Schema.Array(ParallelTaskSchema).annotate({
		description: "Tasks to run in parallel",
	}),
	concurrency: Schema.optional(
		Schema.Number.annotate({ description: "Max concurrent tasks (default: 4)" }),
	),
	failFast: Schema.optional(
		Schema.Boolean.annotate({ description: "Stop on first failure (default: false)" }),
	),
	worktree: Schema.optional(
		Schema.Boolean.annotate({
			description: "Create isolated git worktrees for each parallel task.",
		}),
	),
}).annotate({ identifier: "ParallelStep" });

export type ParallelStep = typeof ParallelStepSchema.Type;

// ============================================================================
// ChainItem — sequential OR parallel step
// ============================================================================

export const ChainItemSchema = Schema.Union([SequentialStepSchema, ParallelStepSchema]).annotate({
	identifier: "ChainItem",
	description:
		"Chain step: either {agent, task?, ...} for sequential or {parallel: [...]} for concurrent execution",
});

export type ChainItem = typeof ChainItemSchema.Type;
