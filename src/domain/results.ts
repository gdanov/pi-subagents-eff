/**
 * Result schemas — ported from types.ts:74-128.
 *
 * SingleResult is the core per-agent result shape. Details is the
 * top-level tool-result wrapping aggregating zero or more SingleResults
 * (single mode = 1, parallel/chain = N).
 *
 * Both shapes are encoded as JSON in metadata.json artifacts AND as
 * tool-call output messages, so encode/decode round-trip is part of the
 * extension contract.
 *
 * `messages` is left as `Schema.Unknown` here — the canonical Message
 * type lives in @mariozechner/pi-ai and changes orthogonally to this
 * extension. Per-message access goes through the duck-typed helpers in
 * domain/messages.ts; full schema-level decoding of messages is out of
 * scope for this extension.
 */
import { Schema } from "effect";
import { ArtifactPathsSchema } from "./artifacts.ts";
import { AgentProgressSchema, ProgressSummarySchema } from "./progress.ts";

export const UsageSchema = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	cacheRead: Schema.Number,
	cacheWrite: Schema.Number,
	cost: Schema.Number,
	turns: Schema.Number,
}).annotate({ identifier: "Usage" });

export type Usage = typeof UsageSchema.Type;

export const ModelAttemptSchema = Schema.Struct({
	model: Schema.String,
	success: Schema.Boolean,
	exitCode: Schema.optional(Schema.Union([Schema.Number, Schema.Null])),
	error: Schema.optional(Schema.String),
	usage: Schema.optional(UsageSchema),
}).annotate({ identifier: "ModelAttempt" });

export type ModelAttempt = typeof ModelAttemptSchema.Type;

const TruncationResultSchema = Schema.Struct({
	text: Schema.String,
	truncated: Schema.Boolean,
	originalBytes: Schema.optional(Schema.Number),
	originalLines: Schema.optional(Schema.Number),
	artifactPath: Schema.optional(Schema.String),
}).annotate({ identifier: "TruncationResult" });

export const SingleResultSchema = Schema.Struct({
	agent: Schema.String,
	task: Schema.String,
	exitCode: Schema.Number,
	detached: Schema.optional(Schema.Boolean),
	detachedReason: Schema.optional(Schema.String),
	messages: Schema.Array(Schema.Unknown),
	usage: UsageSchema,
	model: Schema.optional(Schema.String),
	attemptedModels: Schema.optional(Schema.Array(Schema.String)),
	modelAttempts: Schema.optional(Schema.Array(ModelAttemptSchema)),
	error: Schema.optional(Schema.String),
	sessionFile: Schema.optional(Schema.String),
	skills: Schema.optional(Schema.Array(Schema.String)),
	skillsWarning: Schema.optional(Schema.String),
	progress: Schema.optional(AgentProgressSchema),
	progressSummary: Schema.optional(ProgressSummarySchema),
	artifactPaths: Schema.optional(ArtifactPathsSchema),
	truncation: Schema.optional(TruncationResultSchema),
	finalOutput: Schema.optional(Schema.String),
	savedOutputPath: Schema.optional(Schema.String),
	outputSaveError: Schema.optional(Schema.String),
}).annotate({ identifier: "SingleResult" });

export type SingleResult = typeof SingleResultSchema.Type;

export const DetailsModeSchema = Schema.Literals(["single", "parallel", "chain", "management"]);
export type DetailsMode = typeof DetailsModeSchema.Type;

export const DetailsContextSchema = Schema.Literals(["fresh", "fork"]);
export type DetailsContext = typeof DetailsContextSchema.Type;

const DetailsArtifactsSchema = Schema.Struct({
	dir: Schema.String,
	files: Schema.Array(ArtifactPathsSchema),
});

const DetailsTruncationSchema = Schema.Struct({
	truncated: Schema.Boolean,
	originalBytes: Schema.optional(Schema.Number),
	originalLines: Schema.optional(Schema.Number),
	artifactPath: Schema.optional(Schema.String),
});

export const DetailsSchema = Schema.Struct({
	mode: DetailsModeSchema,
	context: Schema.optional(DetailsContextSchema),
	results: Schema.Array(SingleResultSchema),
	asyncId: Schema.optional(Schema.String),
	asyncDir: Schema.optional(Schema.String),
	progress: Schema.optional(Schema.Array(AgentProgressSchema)),
	progressSummary: Schema.optional(ProgressSummarySchema),
	artifacts: Schema.optional(DetailsArtifactsSchema),
	truncation: Schema.optional(DetailsTruncationSchema),
	chainAgents: Schema.optional(Schema.Array(Schema.String)),
	totalSteps: Schema.optional(Schema.Number),
	currentStepIndex: Schema.optional(Schema.Number),
}).annotate({ identifier: "Details" });

export type Details = typeof DetailsSchema.Type;
