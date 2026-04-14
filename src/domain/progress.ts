/**
 * Progress-tracking schemas — ported from types.ts:47-68.
 *
 * Two surfaces:
 *   - AgentProgress     : per-agent live state during execution.
 *     status discriminates over 5 values; encode/decode preserved for
 *     status.json on-disk parity.
 *   - ProgressSummary   : per-result roll-up.
 *
 * Schemas are deliberately permissive on optional fields (no defaults)
 * because the legacy producer omits unset fields entirely.
 */
import { Schema } from "effect";

export const AgentProgressStatusSchema = Schema.Literals([
	"pending",
	"running",
	"completed",
	"failed",
	"detached",
]);

export type AgentProgressStatus = typeof AgentProgressStatusSchema.Type;

const RecentToolSchema = Schema.Struct({
	tool: Schema.String,
	args: Schema.String,
	endMs: Schema.Number,
});

export const AgentProgressSchema = Schema.Struct({
	index: Schema.Number,
	agent: Schema.String,
	status: AgentProgressStatusSchema,
	task: Schema.String,
	skills: Schema.optional(Schema.Array(Schema.String)),
	currentTool: Schema.optional(Schema.String),
	currentToolArgs: Schema.optional(Schema.String),
	recentTools: Schema.Array(RecentToolSchema),
	recentOutput: Schema.Array(Schema.String),
	toolCount: Schema.Number,
	tokens: Schema.Number,
	durationMs: Schema.Number,
	error: Schema.optional(Schema.String),
	failedTool: Schema.optional(Schema.String),
}).annotate({ identifier: "AgentProgress" });

export type AgentProgress = typeof AgentProgressSchema.Type;

export const ProgressSummarySchema = Schema.Struct({
	toolCount: Schema.Number,
	tokens: Schema.Number,
	durationMs: Schema.Number,
}).annotate({ identifier: "ProgressSummary" });

export type ProgressSummary = typeof ProgressSummarySchema.Type;
