/**
 * Tests for src/services/RunHistory.ts.
 *
 * Verifies record + read round-trip and per-agent filtering.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import { HISTORY_PATH, RunHistory, RunHistoryLive } from "../../src/services/RunHistory.ts";
import { makeFileSystemTest } from "../../src/services/FileSystem.ts";

describe("RunHistory", () => {
	it("record + listAll round-trips entries", async () => {
		const fs = makeFileSystemTest();
		const layer = Layer.provide(RunHistoryLive, fs.layer);
		const entries = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const hist = yield* RunHistory;
					yield* hist.record({ agent: "scout", task: "find", exitCode: 0, durationMs: 100 });
					yield* hist.record({ agent: "worker", task: "build", exitCode: 1, durationMs: 200 });
					return yield* hist.listAll;
				}),
				layer,
			),
		);
		assert.equal(entries.length, 2);
		assert.equal(entries[0]?.agent, "scout");
		assert.equal(entries[0]?.status, "ok");
		assert.equal(entries[0]?.exit, undefined);
		assert.equal(entries[1]?.agent, "worker");
		assert.equal(entries[1]?.status, "error");
		assert.equal(entries[1]?.exit, 1);
	});

	it("loadForAgent filters and reverses (most recent first)", async () => {
		const fs = makeFileSystemTest();
		const layer = Layer.provide(RunHistoryLive, fs.layer);
		const filtered = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const hist = yield* RunHistory;
					yield* hist.record({ agent: "scout", task: "a", exitCode: 0, durationMs: 1 });
					yield* hist.record({ agent: "worker", task: "b", exitCode: 0, durationMs: 1 });
					yield* hist.record({ agent: "scout", task: "c", exitCode: 0, durationMs: 1 });
					return yield* hist.loadForAgent("scout");
				}),
				layer,
			),
		);
		assert.equal(filtered.length, 2);
		// most-recent-first
		assert.equal(filtered[0]?.task, "c");
		assert.equal(filtered[1]?.task, "a");
	});

	it("listAll on missing history file returns []", async () => {
		const fs = makeFileSystemTest();
		const layer = Layer.provide(RunHistoryLive, fs.layer);
		const entries = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const hist = yield* RunHistory;
					return yield* hist.listAll;
				}),
				layer,
			),
		);
		assert.deepEqual(entries, []);
	});

	it("truncates task to 200 chars", async () => {
		const fs = makeFileSystemTest();
		const layer = Layer.provide(RunHistoryLive, fs.layer);
		const long = "x".repeat(500);
		const entries = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const hist = yield* RunHistory;
					yield* hist.record({ agent: "a", task: long, exitCode: 0, durationMs: 1 });
					return yield* hist.listAll;
				}),
				layer,
			),
		);
		assert.equal(entries[0]?.task.length, 200);
	});

	it("HISTORY_PATH points at ~/.pi/agent/run-history.jsonl", () => {
		assert.match(HISTORY_PATH, /\.pi\/agent\/run-history\.jsonl$/);
	});
});
