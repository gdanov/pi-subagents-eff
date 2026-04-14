/**
 * Tests for src/executor/parallel.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Exit } from "effect";
import {
	aggregateParallelOutputs,
	flattenSteps,
	isRunnerParallelGroup,
	runWithConcurrency,
	type ParallelTaskResult,
	type RunnerStep,
} from "../../src/executor/parallel.ts";

describe("runWithConcurrency", () => {
	it("runs all items and preserves index order", async () => {
		const items = [10, 20, 30, 40];
		const results = await Effect.runPromise(
			runWithConcurrency(items, 2, (item) => Effect.succeed(item * 2)),
		);
		assert.deepEqual([...results], [20, 40, 60, 80]);
	});

	it("honors the concurrency bound", async () => {
		let inFlight = 0;
		let peak = 0;
		const items = Array.from({ length: 6 }, (_, i) => i);
		await Effect.runPromise(
			runWithConcurrency(items, 2, () =>
				Effect.gen(function* () {
					inFlight += 1;
					if (inFlight > peak) peak = inFlight;
					yield* Effect.sleep("10 millis");
					inFlight -= 1;
					return true;
				}),
			),
		);
		assert.equal(peak, 2);
	});

	it("aborts sibling tasks when any fails (Effect.all default)", async () => {
		let ranSecond = false;
		const exit = await Effect.runPromiseExit(
			runWithConcurrency([1, 2], 1, (i) =>
				i === 1
					? Effect.fail("boom" as const)
					: Effect.gen(function* () {
							ranSecond = true;
							yield* Effect.sleep("20 millis");
							return i;
						}),
			),
		);
		assert.equal(Exit.isFailure(exit), true);
		// With concurrency: 1 the second effect never starts after the
		// first fails.
		assert.equal(ranSecond, false);
	});

	it("clamps concurrency <= 0 to 1", async () => {
		const results = await Effect.runPromise(
			runWithConcurrency([1, 2, 3], 0, (i) => Effect.succeed(i)),
		);
		assert.deepEqual([...results], [1, 2, 3]);
	});
});

describe("aggregateParallelOutputs", () => {
	const result = (over: Partial<ParallelTaskResult>): ParallelTaskResult => ({
		agent: "worker",
		output: "",
		exitCode: 0,
		...over,
	});

	it("formats successful outputs with headers", () => {
		const text = aggregateParallelOutputs([
			result({ output: "alpha", agent: "a" }),
			result({ output: "beta", agent: "b" }),
		]);
		assert.match(text, /=== Parallel Task 1 \(a\) ===/);
		assert.match(text, /alpha/);
		assert.match(text, /=== Parallel Task 2 \(b\) ===/);
		assert.match(text, /beta/);
	});

	it("marks -1 exit code as SKIPPED", () => {
		const text = aggregateParallelOutputs([result({ exitCode: -1 })]);
		assert.match(text, /⏭️ SKIPPED/);
	});

	it("marks non-zero exit as FAILED with the error message", () => {
		const text = aggregateParallelOutputs([
			result({ exitCode: 2, error: "boom" }),
		]);
		assert.match(text, /⚠️ FAILED \(exit code 2\): boom/);
	});

	it("marks missing output-target file", () => {
		const text = aggregateParallelOutputs([
			result({ outputTargetPath: "/tmp/out.md", outputTargetExists: false }),
		]);
		assert.match(text, /EMPTY OUTPUT \(expected output file missing: \/tmp\/out\.md\)/);
	});
});

describe("flattenSteps / isRunnerParallelGroup", () => {
	it("flattens a mixed sequence into a flat task list", () => {
		const steps: RunnerStep[] = [
			{ agent: "a", task: "A" },
			{ parallel: [{ agent: "b", task: "B" }, { agent: "c", task: "C" }] },
			{ agent: "d", task: "D" },
		];
		const flat = flattenSteps(steps);
		assert.deepEqual(flat.map((t) => t.agent), ["a", "b", "c", "d"]);
		assert.equal(isRunnerParallelGroup(steps[0]!), false);
		assert.equal(isRunnerParallelGroup(steps[1]!), true);
	});
});
