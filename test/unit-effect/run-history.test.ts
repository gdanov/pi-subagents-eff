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

	it("rotates the on-disk file when entries exceed ROTATE_READ_THRESHOLD", async () => {
		// Pre-seed the history file with 1500 lines (well above the
		// 1200 threshold). The next listAll call should slice to the
		// last 1000 in memory AND rewrite the file to match.
		const lines: string[] = [];
		for (let i = 0; i < 1500; i++) {
			lines.push(
				JSON.stringify({
					agent: "scout",
					task: `t${i}`,
					ts: i,
					status: "ok",
					duration: 1,
				}),
			);
		}
		const fs = makeFileSystemTest({ [HISTORY_PATH]: `${lines.join("\n")}\n` });
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
		// In-memory: rotated to last 1000 entries (ROTATE_KEEP).
		assert.equal(entries.length, 1000);
		// First retained entry corresponds to original index 500 (1500 - 1000).
		assert.equal(entries[0]?.task, "t500");
		assert.equal(entries[entries.length - 1]?.task, "t1499");
		// On-disk: file should be shorter now.
		const onDisk = fs.controls.getFile(HISTORY_PATH) ?? "";
		const writtenLines = onDisk.split("\n").filter((l) => l.length > 0);
		assert.equal(writtenLines.length, 1000);
	});

	it("skips malformed JSON lines (matches legacy behavior)", async () => {
		const good = JSON.stringify({
			agent: "scout",
			task: "ok",
			ts: 1,
			status: "ok",
			duration: 1,
		});
		const fs = makeFileSystemTest({
			[HISTORY_PATH]: `${good}\nnot-json\n${good}\n`,
		});
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
		assert.equal(entries.length, 2);
		assert.equal(entries[0]?.task, "ok");
		assert.equal(entries[1]?.task, "ok");
	});
});
