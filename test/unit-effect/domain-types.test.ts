/**
 * Decode-parity tests for the on-disk JSON shapes.
 *
 * These freeze the contract: a status.json / metadata.json that was
 * valid for the legacy code MUST decode under the new Schema. When the
 * Effect-based runner takes over in Phase 7, encoding the same value
 * MUST round-trip back to byte-equivalent JSON for the golden-artifact
 * diff to pass.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Schema } from "effect";
import { AsyncJobStateSchema, AsyncStatusSchema } from "../../src/domain/async-state.ts";
import { AgentProgressSchema } from "../../src/domain/progress.ts";
import { DetailsSchema, SingleResultSchema, UsageSchema } from "../../src/domain/results.ts";

describe("AsyncStatus on-disk decode", () => {
	it("decodes a queued status with no steps yet", async () => {
		const status = await Effect.runPromise(
			Schema.decodeUnknownEffect(AsyncStatusSchema)({
				runId: "abc123",
				mode: "single",
				state: "queued",
				startedAt: 1234567890,
			}),
		);
		assert.equal(status.runId, "abc123");
		assert.equal(status.mode, "single");
		assert.equal(status.state, "queued");
	});

	it("decodes a running chain with per-step progress and tokens", async () => {
		const status = await Effect.runPromise(
			Schema.decodeUnknownEffect(AsyncStatusSchema)({
				runId: "xyz",
				mode: "chain",
				state: "running",
				startedAt: 1,
				lastUpdate: 2,
				currentStep: 1,
				steps: [
					{ agent: "scout", status: "completed", durationMs: 1000, tokens: { input: 10, output: 20, total: 30 } },
					{ agent: "planner", status: "running" },
				],
				totalTokens: { input: 10, output: 20, total: 30 },
			}),
		);
		assert.equal(status.steps?.length, 2);
		assert.equal(status.totalTokens?.total, 30);
	});

	it("rejects unknown state literal", async () => {
		const exit = await Effect.runPromiseExit(
			Schema.decodeUnknownEffect(AsyncStatusSchema)({
				runId: "x",
				mode: "single",
				state: "exploded", // not in the literal set
				startedAt: 1,
			}),
		);
		assert.equal(exit._tag, "Failure");
	});
});

describe("AsyncJobState decode", () => {
	it("decodes minimum required fields", async () => {
		const job = await Effect.runPromise(
			Schema.decodeUnknownEffect(AsyncJobStateSchema)({
				asyncId: "id1",
				asyncDir: "/tmp/x",
				status: "complete",
			}),
		);
		assert.equal(job.asyncId, "id1");
		assert.equal(job.status, "complete");
	});
});

describe("AgentProgress decode", () => {
	it("decodes an idle pending agent", async () => {
		const progress = await Effect.runPromise(
			Schema.decodeUnknownEffect(AgentProgressSchema)({
				index: 0,
				agent: "scout",
				status: "pending",
				task: "find",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				durationMs: 0,
			}),
		);
		assert.equal(progress.status, "pending");
	});

	it("decodes a detached agent (intercom-bridge case)", async () => {
		const progress = await Effect.runPromise(
			Schema.decodeUnknownEffect(AgentProgressSchema)({
				index: 0,
				agent: "scout",
				status: "detached",
				task: "find",
				recentTools: [{ tool: "ls", args: "/tmp", endMs: 1234 }],
				recentOutput: ["line1"],
				toolCount: 1,
				tokens: 100,
				durationMs: 1500,
			}),
		);
		assert.equal(progress.status, "detached");
		assert.equal(progress.recentTools[0]?.tool, "ls");
	});
});

describe("Details decode (top-level tool result)", () => {
	const baseUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

	it("decodes a single-mode result with one agent", async () => {
		const details = await Effect.runPromise(
			Schema.decodeUnknownEffect(DetailsSchema)({
				mode: "single",
				results: [
					{
						agent: "scout",
						task: "find",
						exitCode: 0,
						messages: [],
						usage: baseUsage,
					},
				],
			}),
		);
		assert.equal(details.mode, "single");
		assert.equal(details.results.length, 1);
	});

	it("decodes a chain-mode result with chain metadata", async () => {
		const details = await Effect.runPromise(
			Schema.decodeUnknownEffect(DetailsSchema)({
				mode: "chain",
				results: [
					{ agent: "scout", task: "a", exitCode: 0, messages: [], usage: baseUsage },
					{ agent: "planner", task: "b", exitCode: 0, messages: [], usage: baseUsage },
				],
				chainAgents: ["scout", "planner"],
				totalSteps: 2,
				currentStepIndex: 1,
			}),
		);
		assert.deepEqual(details.chainAgents, ["scout", "planner"]);
	});

	it("decodes a management-mode result with empty results array", async () => {
		const details = await Effect.runPromise(
			Schema.decodeUnknownEffect(DetailsSchema)({ mode: "management", results: [] }),
		);
		assert.equal(details.mode, "management");
		assert.equal(details.results.length, 0);
	});

	it("rejects unknown mode literal", async () => {
		const exit = await Effect.runPromiseExit(
			Schema.decodeUnknownEffect(DetailsSchema)({ mode: "weird", results: [] }),
		);
		assert.equal(exit._tag, "Failure");
	});
});

describe("SingleResult round-trip", () => {
	it("encodes and decodes a richly-populated result", async () => {
		const original = {
			agent: "worker",
			task: "do thing",
			exitCode: 0,
			messages: [],
			usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 },
			model: "anthropic/claude-sonnet-4",
			attemptedModels: ["anthropic/claude-sonnet-4"],
			progressSummary: { toolCount: 5, tokens: 300, durationMs: 1500 },
			finalOutput: "hello",
		};
		const decoded = await Effect.runPromise(
			Schema.decodeUnknownEffect(SingleResultSchema)(original),
		);
		const encoded = await Effect.runPromise(
			Schema.encodeUnknownEffect(SingleResultSchema)(decoded),
		);
		// Encoded shape contains the same keys (encode is identity for plain Struct).
		assert.equal((encoded as { agent: string }).agent, "worker");
		assert.equal((encoded as { exitCode: number }).exitCode, 0);
	});
});

describe("Usage decode rejects missing fields", () => {
	it("requires all six numeric fields", async () => {
		const exit = await Effect.runPromiseExit(
			Schema.decodeUnknownEffect(UsageSchema)({ input: 1, output: 2 }),
		);
		assert.equal(exit._tag, "Failure");
	});
});
