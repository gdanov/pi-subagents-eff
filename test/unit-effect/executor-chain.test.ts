/**
 * Tests for src/executor/chain.ts.
 *
 * Wires together: PiSpawner (Test) + InMemory FileSystem +
 * ArtifactStore (Live over Test FS) + ModelResolver (Live).
 *
 * Verifies:
 *   - Sequential 3-step chain threads {previous} correctly.
 *   - {chain_dir} substitution works.
 *   - Parallel step fan-out aggregates outputs.
 *   - Sequential failure short-circuits with ChainStepFailed.
 *   - Parallel failFast=false produces synthetic failed result without
 *     aborting siblings.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { ChainStepFailed } from "../../src/errors.ts";
import { ArtifactStoreLive } from "../../src/services/ArtifactStore.ts";
import { makeFileSystemTest } from "../../src/services/FileSystem.ts";
import { ModelResolverLive } from "../../src/services/ModelResolver.ts";
import {
	makePiSpawnerTest,
	type PiEvent,
} from "../../src/services/PiSpawner.ts";
import { runChain } from "../../src/executor/chain.ts";
import type { RunSingleAgent } from "../../src/executor/single.ts";
import type { MinimalAgentConfig } from "../../src/executor/chain-settings.ts";

type ChainAgent = RunSingleAgent & MinimalAgentConfig;

const CHAIN_DIR = "/chain/run-1";

function assistantSaying(text: string): PiEvent {
	return {
		type: "stdout",
		line: JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		}),
	};
}
const EXIT_OK: PiEvent = { type: "exit", code: 0, signal: null };
const EXIT_FAIL: PiEvent = { type: "exit", code: 1, signal: null };

function buildLayer(scripts: ReadonlyArray<{ readonly events: ReadonlyArray<PiEvent>; readonly spec?: (s: { readonly args: ReadonlyArray<string> }) => void }>) {
	const fs = makeFileSystemTest();
	const spawner = makePiSpawnerTest(scripts);
	return {
		fs,
		spawner,
		layer: Layer.mergeAll(
			fs.layer,
			spawner.layer,
			Layer.provide(ArtifactStoreLive, fs.layer),
			ModelResolverLive,
		),
	};
}

const SCOUT: ChainAgent = { name: "scout", systemPrompt: "scout prompt" };
const PLANNER: ChainAgent = { name: "planner", systemPrompt: "planner prompt" };
const REVIEWER: ChainAgent = { name: "reviewer", systemPrompt: "reviewer prompt" };

describe("runChain — sequential", () => {
	it("threads {previous} from one step into the next", async () => {
		// Three steps: scout, planner, reviewer. Each spawn captures its
		// task arg so we can assert what {previous} looked like.
		const taskArgs: string[] = [];
		const captureTask = (s: { readonly args: ReadonlyArray<string> }) => {
			const idx = s.args.findIndex((a) => a.startsWith("Task: "));
			if (idx >= 0) taskArgs.push(s.args[idx]!);
		};

		const { layer } = buildLayer([
			{ events: [assistantSaying("scout output"), EXIT_OK], spec: captureTask },
			{ events: [assistantSaying("planner output"), EXIT_OK], spec: captureTask },
			{ events: [assistantSaying("reviewer output"), EXIT_OK], spec: captureTask },
		]);

		const out = await Effect.runPromise(
			Effect.provide(
				runChain(
					{
						steps: [{ agent: "scout" }, { agent: "planner" }, { agent: "reviewer" }],
						originalTask: "find bugs",
						runId: "run-1",
						chainDir: CHAIN_DIR,
						agents: [SCOUT, PLANNER, REVIEWER],
					},
					{},
				),
				layer,
			),
		);

		assert.equal(out.results.length, 3);
		assert.deepEqual([...out.chainAgents], ["scout", "planner", "reviewer"]);
		assert.equal(out.finalOutput, "reviewer output");

		// Step 0 default template = {task} -> "find bugs"
		assert.match(taskArgs[0]!, /Task: find bugs/);
		// Step 1 default template = {previous} -> "scout output"
		assert.match(taskArgs[1]!, /Task: scout output/);
		// Step 2 default template = {previous} -> "planner output"
		assert.match(taskArgs[2]!, /Task: planner output/);
	});

	it("substitutes {chain_dir} into explicit task templates", async () => {
		const captured: string[] = [];
		const captureTask = (s: { readonly args: ReadonlyArray<string> }) => {
			const idx = s.args.findIndex((a) => a.startsWith("Task: "));
			if (idx >= 0) captured.push(s.args[idx]!);
		};
		const { layer } = buildLayer([
			{
				events: [assistantSaying("ok"), EXIT_OK],
				spec: captureTask,
			},
		]);

		await Effect.runPromise(
			Effect.provide(
				runChain(
					{
						steps: [{ agent: "scout", task: "Inspect {chain_dir}/notes.md" }],
						originalTask: "anything",
						runId: "r",
						chainDir: CHAIN_DIR,
						agents: [SCOUT],
					},
					{},
				),
				layer,
			),
		);
		assert.match(captured[0]!, /Inspect \/chain\/run-1\/notes\.md/);
	});

	it("fails with ChainStepFailed when a sequential step exits non-zero", async () => {
		const { layer } = buildLayer([{ events: [assistantSaying("oops"), EXIT_FAIL] }]);
		const exit = await Effect.runPromiseExit(
			Effect.provide(
				runChain(
					{
						steps: [{ agent: "scout" }],
						originalTask: "x",
						runId: "r",
						chainDir: CHAIN_DIR,
						agents: [SCOUT],
					},
					{},
				),
				layer,
			),
		);
		if (Exit.isFailure(exit)) {
			const err = Cause.findErrorOption(exit.cause);
			if (Option.isSome(err)) {
				assert.ok(err.value instanceof ChainStepFailed);
				assert.equal(err.value.stepIndex, 0);
				assert.equal(err.value.agent, "scout");
			}
		} else {
			assert.fail("expected failure");
		}
	});
});

describe("runChain — parallel substep", () => {
	it("aggregates parallel outputs into the next {previous}", async () => {
		// Step 0: parallel [worker, worker]; step 1: sequential reviewer.
		// We verify reviewer's task arg includes both parallel outputs.
		const captured: string[] = [];
		const captureTask = (s: { readonly args: ReadonlyArray<string> }) => {
			const idx = s.args.findIndex((a) => a.startsWith("Task: "));
			if (idx >= 0) captured.push(s.args[idx]!);
		};
		const { layer } = buildLayer([
			{ events: [assistantSaying("alpha output"), EXIT_OK], spec: captureTask },
			{ events: [assistantSaying("beta output"), EXIT_OK], spec: captureTask },
			{ events: [assistantSaying("review done"), EXIT_OK], spec: captureTask },
		]);

		const WORKER: ChainAgent = { name: "worker", systemPrompt: "worker" };
		const out = await Effect.runPromise(
			Effect.provide(
				runChain(
					{
						steps: [
							{ parallel: [{ agent: "worker", task: "do A" }, { agent: "worker", task: "do B" }] },
							{ agent: "reviewer" },
						],
						originalTask: "outer",
						runId: "r",
						chainDir: CHAIN_DIR,
						agents: [WORKER, REVIEWER],
					},
					{ defaultConcurrency: 2 },
				),
				layer,
			),
		);
		assert.equal(out.results.length, 3);
		// Reviewer's task should contain the aggregated parallel block.
		const reviewerTask = captured[2] ?? "";
		assert.match(reviewerTask, /=== Parallel Task 1 \(worker\) ===/);
		assert.match(reviewerTask, /alpha output/);
		assert.match(reviewerTask, /=== Parallel Task 2 \(worker\) ===/);
		assert.match(reviewerTask, /beta output/);
	});

	it("failFast=false captures a failed parallel task without aborting siblings", async () => {
		// One parallel task fails (exit 1); the other succeeds. With
		// failFast=false the failed task surfaces as a synthetic failed
		// SingleResult and the chain continues.
		const { layer } = buildLayer([
			{ events: [assistantSaying("ok"), EXIT_OK] },
			{ events: [assistantSaying("oh no"), EXIT_FAIL] },
		]);

		const WORKER: ChainAgent = { name: "worker", systemPrompt: "worker" };
		const out = await Effect.runPromise(
			Effect.provide(
				runChain(
					{
						steps: [
							{
								parallel: [{ agent: "worker", task: "A" }, { agent: "worker", task: "B" }],
								failFast: false,
							},
						],
						originalTask: "x",
						runId: "r",
						chainDir: CHAIN_DIR,
						agents: [WORKER],
					},
					{},
				),
				layer,
			),
		);
		assert.equal(out.results.length, 2);
		const failedCount = out.results.filter((r) => r.exitCode !== 0).length;
		assert.equal(failedCount, 1);
	});
});
