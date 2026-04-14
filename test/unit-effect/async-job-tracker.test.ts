/**
 * Tests for src/services/AsyncJobTracker.ts.
 *
 * Covers register / get / list / markCompleted lifecycle. The poll
 * loop and 10s removal timer are exercised via behavioural assertions
 * on register + markCompleted (no fake clock here; the timer tests are
 * delivered later when async/await covers them in integration).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import {
	AsyncJobTracker,
	makeAsyncJobTrackerLive,
} from "../../src/services/AsyncJobTracker.ts";
import { makeFileSystemTest } from "../../src/services/FileSystem.ts";
import { makePiEventBusTest } from "../../src/services/PiEventBus.ts";

function build() {
	const fs = makeFileSystemTest();
	const bus = makePiEventBusTest();
	// Removal delay = 1 ms so the detached cleanup fiber doesn't keep
	// the test runtime alive for the production 10s window.
	const tracker = makeAsyncJobTrackerLive({ completionRemovalDelayMs: 1 });
	const layer = Layer.mergeAll(
		fs.layer,
		bus.layer,
		Layer.provide(tracker, Layer.merge(fs.layer, bus.layer)),
	);
	return { fs, bus, layer };
}

describe("AsyncJobTracker.register", () => {
	it("adds a queued job and announces a change", async () => {
		const { bus, layer } = build();
		const list = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const t = yield* AsyncJobTracker;
					yield* t.register({ id: "run-1", agent: "scout" });
					return yield* t.list;
				}),
				layer,
			),
		);
		assert.equal(list.length, 1);
		assert.equal(list[0]?.asyncId, "run-1");
		assert.equal(list[0]?.status, "queued");
		assert.equal(list[0]?.mode, "single");

		// Change channel was fired with the new snapshot.
		const changes = bus.controls.published().filter((e) => e.channel === "subagent:tracker:changed");
		assert.ok(changes.length >= 1);
	});

	it("ignores payloads without id", async () => {
		const { layer } = build();
		const list = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const t = yield* AsyncJobTracker;
					yield* t.register({ agent: "scout" });
					return yield* t.list;
				}),
				layer,
			),
		);
		assert.equal(list.length, 0);
	});

	it("infers asyncDir from asyncDirRoot when not given", async () => {
		const { layer } = build();
		const list = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const t = yield* AsyncJobTracker;
					yield* t.register({ id: "abc", agent: "x", asyncDirRoot: "/tmp/runs" });
					return yield* t.list;
				}),
				layer,
			),
		);
		assert.equal(list[0]?.asyncDir, "/tmp/runs/abc");
	});

	it("chain mode when payload includes a chain array", async () => {
		const { layer } = build();
		const list = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const t = yield* AsyncJobTracker;
					yield* t.register({ id: "c", chain: ["scout", "planner", "reviewer"] });
					return yield* t.list;
				}),
				layer,
			),
		);
		assert.equal(list[0]?.mode, "chain");
		assert.deepEqual([...(list[0]?.agents ?? [])], ["scout", "planner", "reviewer"]);
		assert.equal(list[0]?.stepsTotal, 3);
	});
});

describe("AsyncJobTracker.get", () => {
	it("returns the job by exact id", async () => {
		const { layer } = build();
		const got = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const t = yield* AsyncJobTracker;
					yield* t.register({ id: "run-12345", agent: "x" });
					return yield* t.get("run-12345");
				}),
				layer,
			),
		);
		assert.equal(got?.asyncId, "run-12345");
	});

	it("returns the job by prefix when no exact match", async () => {
		const { layer } = build();
		const got = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const t = yield* AsyncJobTracker;
					yield* t.register({ id: "run-abcdefg", agent: "x" });
					return yield* t.get("run-abc");
				}),
				layer,
			),
		);
		assert.equal(got?.asyncId, "run-abcdefg");
	});
});

describe("AsyncJobTracker.markCompleted", () => {
	it("flips status and emits a change event", async () => {
		const { bus, layer } = build();
		const list = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const t = yield* AsyncJobTracker;
					yield* t.register({ id: "r", agent: "x" });
					yield* t.markCompleted({ id: "r", success: true });
					return yield* t.list;
				}),
				layer,
			),
		);
		assert.equal(list[0]?.status, "complete");
		const changes = bus.controls.published().filter((e) => e.channel === "subagent:tracker:changed");
		// register + markCompleted = 2 change events at minimum (the
		// 10s removal also emits later but won't fire in this test).
		assert.ok(changes.length >= 2);
	});

	it("marks failed when success: false", async () => {
		const { layer } = build();
		const list = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const t = yield* AsyncJobTracker;
					yield* t.register({ id: "r", agent: "x" });
					yield* t.markCompleted({ id: "r", success: false });
					return yield* t.list;
				}),
				layer,
			),
		);
		assert.equal(list[0]?.status, "failed");
	});
});

describe("AsyncJobTracker.clear", () => {
	it("empties the map", async () => {
		const { layer } = build();
		const list = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const t = yield* AsyncJobTracker;
					yield* t.register({ id: "a", agent: "x" });
					yield* t.register({ id: "b", agent: "y" });
					yield* t.clear;
					return yield* t.list;
				}),
				layer,
			),
		);
		assert.equal(list.length, 0);
	});
});
