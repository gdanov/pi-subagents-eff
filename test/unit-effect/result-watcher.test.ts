/**
 * Tests for src/services/ResultWatcher.ts.
 *
 * Exercises the Stream pipeline against an InMemory FileSystem +
 * Test PiEventBus. Drives synthetic watch events via fs.controls.emit
 * to keep tests deterministic without sleeping on real fs.watch.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import { makeFileSystemTest, FileSystem } from "../../src/services/FileSystem.ts";
import { makePiEventBusTest, PiEventBus } from "../../src/services/PiEventBus.ts";
import { ResultWatcher, ResultWatcherLive } from "../../src/services/ResultWatcher.ts";

const RESULTS_DIR = "/tmp/results";

function build() {
	const fs = makeFileSystemTest();
	const bus = makePiEventBusTest();
	const layer = Layer.mergeAll(
		fs.layer,
		bus.layer,
		Layer.provide(ResultWatcherLive, Layer.merge(fs.layer, bus.layer)),
	);
	return { fs, bus, layer };
}

function seedResultFile(fs: ReturnType<typeof makeFileSystemTest>, name: string, payload: object) {
	fs.controls; // touch so layer thinks dir exists
	// Use FileSystem.write via the controls helper (in-memory store).
	// Easiest: write into the store directly via write effect.
	return Effect.provide(
		Effect.gen(function* () {
			const f = yield* FileSystem;
			yield* f.mkdir(RESULTS_DIR);
			yield* f.write(path.join(RESULTS_DIR, name), JSON.stringify(payload));
		}),
		fs.layer,
	);
}

describe("ResultWatcher.prime", () => {
	it("processes existing JSON files and publishes subagent:complete once each", async () => {
		const { fs, bus, layer } = build();
		await Effect.runPromise(seedResultFile(fs, "run-1.json", { id: "run-1", success: true }));
		await Effect.runPromise(seedResultFile(fs, "run-2.json", { id: "run-2", success: false }));
		await Effect.runPromise(seedResultFile(fs, "ignore.txt", { unrelated: true }));

		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const w = yield* ResultWatcher;
					yield* w.prime(RESULTS_DIR);
				}),
				layer,
			),
		);

		const completed = bus.controls
			.published()
			.filter((e) => e.channel === "subagent:complete")
			.map((e) => (e.payload as { id?: string }).id);
		assert.deepEqual(completed.sort(), ["run-1", "run-2"]);
		// Files were removed after publish.
		assert.equal(fs.controls.getFile(path.join(RESULTS_DIR, "run-1.json")), undefined);
		assert.equal(fs.controls.getFile(path.join(RESULTS_DIR, "run-2.json")), undefined);
		// .txt was ignored, still there.
		assert.ok(fs.controls.getFile(path.join(RESULTS_DIR, "ignore.txt")));
	});

	it("dedupes via buildCompletionKey when the same result appears twice", async () => {
		const { fs, bus, layer } = build();
		const payload = { id: "run-x", success: true };
		await Effect.runPromise(seedResultFile(fs, "first.json", payload));
		await Effect.runPromise(seedResultFile(fs, "second.json", payload));

		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const w = yield* ResultWatcher;
					yield* w.prime(RESULTS_DIR);
				}),
				layer,
			),
		);

		const completed = bus.controls
			.published()
			.filter((e) => e.channel === "subagent:complete");
		assert.equal(completed.length, 1, "second arrival should be deduped");
	});

	it("filter.accept can suppress publishing", async () => {
		const { fs, bus, layer } = build();
		await Effect.runPromise(seedResultFile(fs, "x.json", { id: "x", sessionId: "wrong-session" }));

		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const w = yield* ResultWatcher;
					yield* w.prime(RESULTS_DIR, {
						accept: (data) => (data as { sessionId?: string }).sessionId === "right-session",
					});
				}),
				layer,
			),
		);

		const completed = bus.controls.published().filter((e) => e.channel === "subagent:complete");
		assert.equal(completed.length, 0);
	});
});

describe("ResultWatcher dedup pure helper", () => {
	it("buildCompletionKey is stable for identical payloads", async () => {
		const { buildCompletionKey } = await import("../../src/services/ResultWatcher.ts");
		const a = buildCompletionKey({ id: "x" }, "f1");
		const b = buildCompletionKey({ id: "x" }, "f2");
		// id-bearing payloads use the id as the key, fallback ignored.
		assert.equal(a, b);
		assert.equal(a, "id:x");
	});

	it("keys without id include sessionId+agent+timestamp+fallback", async () => {
		const { buildCompletionKey } = await import("../../src/services/ResultWatcher.ts");
		const k = buildCompletionKey(
			{ sessionId: "s", agent: "a", timestamp: 1, success: true },
			"file:f.json",
		);
		assert.equal(k, "meta:s:a:1:-:-:1:file:f.json");
	});
});
