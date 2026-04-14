/**
 * Async-execution state schemas — ported from types.ts:154-194.
 *
 * Both schemas back on-disk JSON files:
 *   - AsyncStatus: written to {asyncDir}/status.json by the runner;
 *     read by AsyncJobTracker poller and the subagent_status tool.
 *   - AsyncJobState: parent-process in-memory record of a tracked job.
 *     Subset of AsyncStatus shape; encoded only when serializing
 *     across the runner / parent boundary.
 *
 * State machines:
 *   AsyncStatus.state    : "queued" | "running" | "complete" | "failed"
 *   AsyncJobState.status : same four values
 *   AsyncStatus.mode     : "single" | "chain"     (parallel runs as
 *                          chain in the runner config)
 */
import { Schema } from "effect";
import { ModelAttemptSchema } from "./results.ts";

export const TokenUsageSchema = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	total: Schema.Number,
}).annotate({ identifier: "TokenUsage" });

export type TokenUsage = typeof TokenUsageSchema.Type;

const AsyncStatusStepSchema = Schema.Struct({
	agent: Schema.String,
	status: Schema.String,
	durationMs: Schema.optional(Schema.Number),
	tokens: Schema.optional(TokenUsageSchema),
	skills: Schema.optional(Schema.Array(Schema.String)),
	model: Schema.optional(Schema.String),
	attemptedModels: Schema.optional(Schema.Array(Schema.String)),
	modelAttempts: Schema.optional(Schema.Array(ModelAttemptSchema)),
	error: Schema.optional(Schema.String),
});

export const AsyncStatusStateSchema = Schema.Literals(["queued", "running", "complete", "failed"]);
export type AsyncStatusState = typeof AsyncStatusStateSchema.Type;

export const AsyncStatusModeSchema = Schema.Literals(["single", "chain"]);
export type AsyncStatusMode = typeof AsyncStatusModeSchema.Type;

export const AsyncStatusSchema = Schema.Struct({
	runId: Schema.String,
	mode: AsyncStatusModeSchema,
	state: AsyncStatusStateSchema,
	startedAt: Schema.Number,
	endedAt: Schema.optional(Schema.Number),
	lastUpdate: Schema.optional(Schema.Number),
	cwd: Schema.optional(Schema.String),
	currentStep: Schema.optional(Schema.Number),
	steps: Schema.optional(Schema.Array(AsyncStatusStepSchema)),
	sessionDir: Schema.optional(Schema.String),
	outputFile: Schema.optional(Schema.String),
	totalTokens: Schema.optional(TokenUsageSchema),
	sessionFile: Schema.optional(Schema.String),
}).annotate({ identifier: "AsyncStatus" });

export type AsyncStatus = typeof AsyncStatusSchema.Type;

export const AsyncJobStateSchema = Schema.Struct({
	asyncId: Schema.String,
	asyncDir: Schema.String,
	status: AsyncStatusStateSchema,
	mode: Schema.optional(AsyncStatusModeSchema),
	agents: Schema.optional(Schema.Array(Schema.String)),
	currentStep: Schema.optional(Schema.Number),
	stepsTotal: Schema.optional(Schema.Number),
	startedAt: Schema.optional(Schema.Number),
	updatedAt: Schema.optional(Schema.Number),
	sessionDir: Schema.optional(Schema.String),
	outputFile: Schema.optional(Schema.String),
	totalTokens: Schema.optional(TokenUsageSchema),
	sessionFile: Schema.optional(Schema.String),
}).annotate({ identifier: "AsyncJobState" });

export type AsyncJobState = typeof AsyncJobStateSchema.Type;
