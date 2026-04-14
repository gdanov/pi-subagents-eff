/**
 * Effect Schema for the `subagent` and `subagent_status` tool inputs.
 *
 * Replaces schemas.ts (TypeBox). Single source of truth — JSON Schema
 * for tool registration is generated via Schema.toJsonSchemaDocument
 * and post-processed by schema/typebox-bridge.ts.
 *
 * Naming: every Effect Schema constant is suffixed `Schema`. Decoded
 * TypeScript types are exported via `typeof X.Type` aliases (e.g.
 * `SubagentParams = typeof SubagentParamsSchema.Type`) so consumer
 * call sites that imported plain types from the legacy `schemas.ts`
 * continue to read naturally.
 *
 * Discriminated unions:
 *   - SkillOverrideSchema : string | string[] | boolean
 *     (legacy used Type.Any() because Google's tool API rejects anyOf;
 *     the typebox-bridge collapses this to `additionalProperties: true`
 *     at registration time)
 *   - ChainItemSchema     : Sequential | Parallel
 *     (discriminated by the presence of the `parallel` key — matches
 *     today's on-disk shape; not a tag-discriminator)
 */
import { Schema } from "effect";
import { ChainItemSchema } from "./chain.ts";
import { OutputOverrideSchema, SkillOverrideSchema } from "./common.ts";

// Re-export shared schema fragments so consumers can import them from
// a single barrel module.
export { OutputOverrideSchema, ReadsOverrideSchema, SkillOverrideSchema } from "./common.ts";

// ============================================================================
// Top-level parallel TaskItem (used by SubagentParams.tasks)
// ============================================================================

export const TaskItemSchema = Schema.Struct({
	agent: Schema.String,
	task: Schema.String,
	cwd: Schema.optional(Schema.String),
	count: Schema.optional(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
			description: "Repeat this parallel task N times with the same settings.",
		}),
	),
	model: Schema.optional(
		Schema.String.annotate({
			description: "Override model for this task (e.g. 'google/gemini-3-pro')",
		}),
	),
	skill: Schema.optional(SkillOverrideSchema),
});

// ============================================================================
// SubagentParams — the main `subagent` tool input
// ============================================================================

export const SubagentParamsSchema = Schema.Struct({
	agent: Schema.optional(
		Schema.String.annotate({
			description: "Agent name (SINGLE mode) or target for management get/update/delete",
		}),
	),
	task: Schema.optional(Schema.String.annotate({ description: "Task (SINGLE mode)" })),
	action: Schema.optional(
		Schema.String.annotate({
			description:
				"Management action: 'list' (discover agents/chains), 'get' (full detail), 'create', 'update', 'delete'. Omit for execution mode.",
		}),
	),
	chainName: Schema.optional(
		Schema.String.annotate({
			description: "Chain name for get/update/delete management actions",
		}),
	),
	config: Schema.optional(
		Schema.Unknown.annotate({
			description:
				"Agent or chain config for create/update. Agent: name, description, scope ('user'|'project', default 'user'), systemPrompt, model, tools (comma-separated), extensions (comma-separated), skills (comma-separated), thinking, output, reads, progress, maxSubagentDepth. Chain: name, description, scope, steps (array of {agent, task?, output?, reads?, model?, skills?, progress?}). Presence of 'steps' creates a chain instead of an agent.",
		}),
	),
	tasks: Schema.optional(
		Schema.Array(TaskItemSchema).annotate({
			description: "PARALLEL mode: [{agent, task, count?}, ...]",
		}),
	),
	worktree: Schema.optional(
		Schema.Boolean.annotate({
			description:
				"Create isolated git worktrees for each parallel task. Prevents filesystem conflicts. Requires clean git state. Per-worktree diffs included in output.",
		}),
	),
	chain: Schema.optional(
		Schema.Array(ChainItemSchema).annotate({
			description:
				"CHAIN mode: sequential pipeline where each step's response becomes {previous} for the next. Use {task}, {previous}, {chain_dir} in task templates.",
		}),
	),
	context: Schema.optional(
		Schema.Literals(["fresh", "fork"]).annotate({
			description: "'fresh' (default) or 'fork' to branch from parent session",
		}),
	),
	chainDir: Schema.optional(
		Schema.String.annotate({
			description:
				"Persistent directory for chain artifacts. Default: a user-scoped temp directory under <tmpdir>/ (auto-cleaned after 24h)",
		}),
	),
	async: Schema.optional(
		Schema.Boolean.annotate({
			description: "Run in background (default: false, or per config)",
		}),
	),
	agentScope: Schema.optional(
		Schema.String.annotate({
			description:
				"Agent discovery scope: 'user', 'project', or 'both' (default: 'both'; project wins on name collisions)",
		}),
	),
	cwd: Schema.optional(Schema.String),
	artifacts: Schema.optional(
		Schema.Boolean.annotate({ description: "Write debug artifacts (default: true)" }),
	),
	includeProgress: Schema.optional(
		Schema.Boolean.annotate({
			description: "Include full progress in result (default: false)",
		}),
	),
	share: Schema.optional(
		Schema.Boolean.annotate({
			description: "Upload session to GitHub Gist for sharing (default: false)",
		}),
	),
	sessionDir: Schema.optional(
		Schema.String.annotate({
			description:
				"Directory to store session logs (default: temp; enables sessions even if share=false)",
		}),
	),
	clarify: Schema.optional(
		Schema.Boolean.annotate({
			description:
				"Show TUI to preview/edit before execution (default: true for chains, false for single/parallel). Implies sync mode.",
		}),
	),
	output: Schema.optional(
		OutputOverrideSchema.annotate({
			description:
				"Output file for single agent (string), or false to disable. Relative paths resolve against cwd.",
		}),
	),
	skill: Schema.optional(SkillOverrideSchema),
	model: Schema.optional(
		Schema.String.annotate({
			description: "Override model for single agent (e.g. 'anthropic/claude-sonnet-4')",
		}),
	),
}).annotate({
	identifier: "SubagentParams",
	description: "Input parameters for the `subagent` tool",
});

export type SubagentParams = typeof SubagentParamsSchema.Type;

// ============================================================================
// StatusParams — the `subagent_status` tool input
// ============================================================================

export const StatusParamsSchema = Schema.Struct({
	action: Schema.optional(
		Schema.String.annotate({
			description: "Action: 'list' to show active async runs, or omit to inspect one run by id/dir",
		}),
	),
	id: Schema.optional(Schema.String.annotate({ description: "Async run id or prefix" })),
	dir: Schema.optional(
		Schema.String.annotate({
			description: "Async run directory (overrides id search)",
		}),
	),
}).annotate({
	identifier: "StatusParams",
	description: "Input parameters for the `subagent_status` tool",
});

export type StatusParams = typeof StatusParamsSchema.Type;
