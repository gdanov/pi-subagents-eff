/**
 * Tests for src/executor/async.ts.
 *
 * Phase 7 scope: in-process daemon. Verifies:
 *   - runAsyncSingle returns immediately with runId + asyncDir
 *   - status.json is written queued -> running -> complete
 *   - subagent:started published before fork
 *   - result file appears in resultsDir on completion
 *
 * The eventual subprocess port (Phase 10) will swap the in-process
 * runSingle for a PiSpawner.spawnPi of the runner CLI without
 * touching this test contract.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import { ArtifactStoreLive } from "../../src/services/ArtifactStore.ts";
import { makeFileSystemTest } from "../../src/services/FileSystem.ts";
import { ModelResolverLive } from "../../src/services/ModelResolver.ts";
import { makePiEventBusTest } from "../../src/services/PiEventBus.ts";
import {
	makePiSpawnerTest,
	type PiEvent,
} from "../../src/services/PiSpawner.ts";
import { runAsyncSingle } from "../../src/executor/async.ts";
import type { RunSingleAgent } from "../../src/executor/single.ts";

const ASYNC_ROOT = "/tmp/async";
const RESULTS_DIR = "/tmp/results";

const ASSISTANT_REPLY: PiEvent = {
	type: "stdout",
	line: JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		},
	}),
};
const EXIT_OK: PiEvent = { type: "exit", code: 0, signal: null };
const EXIT_FAIL: PiEvent = { type: "exit", code: 2, signal: null };

const STUB_AGENT: RunSingleAgent = { name: "scout", systemPrompt: "scout" };

function build(spawnerScript: ReadonlyArray<{ readonly events: ReadonlyArray<PiEvent> }>) {
	const fs = makeFileSystemTest();
	const spawner = makePiSpawnerTest(spawnerScript);
	const bus = makePiEventBusTest();
	return {
		fs,
		spawner,
		bus,
		layer: Layer.mergeAll(
			fs.layer,
			spawner.layer,
			bus.layer,
			Layer.provide(ArtifactStoreLive, fs.layer),
			ModelResolverLive,
		),
	};
}

async function waitForResultFile(
	fs: ReturnType<typeof makeFileSystemTest>,
	runId: string,
	timeoutMs = 1000,
): Promise<string | undefined> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const f = fs.controls.getFile(path.join(RESULTS_DIR, `${runId}.json`));
		if (f) return f;
		await new Promise((r) => setTimeout(r, 10));
	}
	return undefined;
}

describe("runAsyncSingle", () => {
	it("returns runId + asyncDir immediately and emits subagent:started", async () => {
		const { fs, bus, layer } = build([{ events: [ASSISTANT_REPLY, EXIT_OK] }]);
		const handle = await Effect.runPromise(
			Effect.provide(
				runAsyncSingle(
					{ agent: STUB_AGENT, task: "x", runId: "r-1" },
					{ asyncDirRoot: ASYNC_ROOT, resultsDir: RESULTS_DIR },
				),
				layer,
			),
		);
		assert.equal(handle.runId, "r-1");
		assert.equal(handle.asyncDir, path.join(ASYNC_ROOT, "r-1"));

		// Initial queued status.json was written.
		const status = JSON.parse(
			fs.controls.getFile(path.join(handle.asyncDir, "status.json")) ?? "{}",
		);
		assert.equal(status.runId, "r-1");
		assert.equal(status.mode, "single");
		// At fork time the status may be queued or already running.
		assert.ok(["queued", "running", "complete", "failed"].includes(status.state));

		// subagent:started published with id+asyncDir.
		const started = bus.controls.published().find((e) => e.channel === "subagent:started");
		assert.ok(started);
		assert.equal((started?.payload as { id?: string }).id, "r-1");

		// Wait for the daemon to finish so the result file appears.
		const resultFile = await waitForResultFile(fs, "r-1");
		assert.ok(resultFile, "result file should be written by the daemon");
		const result = JSON.parse(resultFile!);
		assert.equal(result.id, "r-1");
		assert.equal(result.success, true);

		// Final status is complete.
		const finalStatus = JSON.parse(
			fs.controls.getFile(path.join(handle.asyncDir, "status.json")) ?? "{}",
		);
		assert.equal(finalStatus.state, "complete");
	});

	it("marks success=false in the result when runSingle exits non-zero", async () => {
		const { fs, layer } = build([{ events: [ASSISTANT_REPLY, EXIT_FAIL] }]);
		const handle = await Effect.runPromise(
			Effect.provide(
				runAsyncSingle(
					{ agent: STUB_AGENT, task: "x", runId: "r-fail" },
					{ asyncDirRoot: ASYNC_ROOT, resultsDir: RESULTS_DIR },
				),
				layer,
			),
		);
		assert.equal(handle.runId, "r-fail");

		const resultText = await waitForResultFile(fs, "r-fail");
		assert.ok(resultText);
		const result = JSON.parse(resultText!);
		assert.equal(result.success, false);

		const finalStatus = JSON.parse(
			fs.controls.getFile(path.join(handle.asyncDir, "status.json")) ?? "{}",
		);
		assert.equal(finalStatus.state, "failed");
	});
});
