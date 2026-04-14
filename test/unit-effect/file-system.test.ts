/**
 * Tests for src/services/FileSystem.ts.
 *
 * Two parallel describe blocks for Live and Test layers. The Live tests
 * use a real fresh tmpdir; the Test layer tests use the in-memory
 * fixture. Behavior must match (any drift means the Test layer is
 * lying to consumers).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect";
import { FsNotFound } from "../../src/errors.ts";
import { FileSystem, FileSystemLive, makeFileSystemTest } from "../../src/services/FileSystem.ts";

// ============================================================================
// Live layer
// ============================================================================

describe("FileSystemLive", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fs-live-"));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	const run = <A, E>(effect: Effect.Effect<A, E, FileSystem>): Promise<A> =>
		Effect.runPromise(Effect.provide(effect, FileSystemLive));

	const runExit = <A, E>(effect: Effect.Effect<A, E, FileSystem>): Promise<Exit.Exit<A, E>> =>
		Effect.runPromiseExit(Effect.provide(effect, FileSystemLive));

	it("write + read round-trips", async () => {
		const file = path.join(tmp, "a.txt");
		await run(
			Effect.gen(function* () {
				const fsApi = yield* FileSystem;
				yield* fsApi.write(file, "hello");
				const read = yield* fsApi.read(file);
				assert.equal(read, "hello");
			}),
		);
	});

	it("read of a missing file fails with FsNotFound", async () => {
		const exit = await runExit(
			Effect.gen(function* () {
				const fsApi = yield* FileSystem;
				return yield* fsApi.read(path.join(tmp, "missing.txt"));
			}),
		);
		assert.equal(Exit.isFailure(exit), true);
		if (Exit.isFailure(exit)) {
			const err = Cause.findErrorOption(exit.cause);
			assert.equal(Option.isSome(err), true);
			if (Option.isSome(err)) assert.ok(err.value instanceof FsNotFound);
		}
	});

	it("exists returns true after write, false after rm", async () => {
		const file = path.join(tmp, "b.txt");
		await run(
			Effect.gen(function* () {
				const fsApi = yield* FileSystem;
				yield* fsApi.write(file, "x");
				assert.equal(yield* fsApi.exists(file), true);
				yield* fsApi.rm(file);
				assert.equal(yield* fsApi.exists(file), false);
			}),
		);
	});

	it("mkdir creates nested directories (recursive)", async () => {
		const dir = path.join(tmp, "a", "b", "c");
		await run(
			Effect.gen(function* () {
				const fsApi = yield* FileSystem;
				yield* fsApi.mkdir(dir);
				assert.equal(yield* fsApi.exists(dir), true);
			}),
		);
	});

	it("readDir returns FsNotFound for a missing directory", async () => {
		const exit = await runExit(
			Effect.gen(function* () {
				const fsApi = yield* FileSystem;
				return yield* fsApi.readDir(path.join(tmp, "missing"));
			}),
		);
		if (Exit.isFailure(exit)) {
			const err = Cause.findErrorOption(exit.cause);
			if (Option.isSome(err)) assert.ok(err.value instanceof FsNotFound);
		} else {
			assert.fail("expected failure");
		}
	});

	it("append concatenates", async () => {
		const file = path.join(tmp, "log.txt");
		await run(
			Effect.gen(function* () {
				const fsApi = yield* FileSystem;
				yield* fsApi.append(file, "line1\n");
				yield* fsApi.append(file, "line2\n");
				const read = yield* fsApi.read(file);
				assert.equal(read, "line1\nline2\n");
			}),
		);
	});

	it("watch emits an event for a new file appearing", async () => {
		const file = path.join(tmp, "result.json");
		const collected = await run(
			Effect.gen(function* () {
				const fsApi = yield* FileSystem;
				const fiber = yield* Effect.forkChild(
					fsApi
						.watch(tmp)
						// macOS can emit FSEvents for the parent dir too; filter to our file.
						.pipe(
							Stream.filter((ev) => ev.file === "result.json"),
							Stream.take(1),
							Stream.runCollect,
						),
				);
				// Give the watcher a moment to attach before writing.
				yield* Effect.sleep("100 millis");
				yield* fsApi.write(file, "{}");
				return yield* Fiber.join(fiber);
			}),
		);
		const events = Array.from(collected);
		assert.equal(events.length, 1);
		assert.equal(events[0]?.file, "result.json");
	});
});

// ============================================================================
// Test layer
// ============================================================================

describe("FileSystem Test layer", () => {
	it("seeded files are readable", async () => {
		const { layer } = makeFileSystemTest({ "/seed.txt": "hi" });
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const fsApi = yield* FileSystem;
					return yield* fsApi.read("/seed.txt");
				}),
				layer,
			),
		);
		assert.equal(result, "hi");
	});

	it("missing read fails with FsNotFound", async () => {
		const { layer } = makeFileSystemTest();
		const exit = await Effect.runPromiseExit(
			Effect.provide(
				Effect.gen(function* () {
					const fsApi = yield* FileSystem;
					return yield* fsApi.read("/nope");
				}),
				layer,
			),
		);
		if (Exit.isFailure(exit)) {
			const err = Cause.findErrorOption(exit.cause);
			if (Option.isSome(err)) assert.ok(err.value instanceof FsNotFound);
		} else {
			assert.fail("expected failure");
		}
	});

	it("write + append behaves like the Live layer", async () => {
		const { layer, controls } = makeFileSystemTest();
		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const fsApi = yield* FileSystem;
					yield* fsApi.write("/a.txt", "one\n");
					yield* fsApi.append("/a.txt", "two\n");
				}),
				layer,
			),
		);
		assert.equal(controls.getFile("/a.txt"), "one\ntwo\n");
	});

	it("emit drives watch subscribers", async () => {
		const { layer, controls } = makeFileSystemTest();
		const collectedPromise = Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const fsApi = yield* FileSystem;
					return yield* fsApi.watch("/dir").pipe(Stream.take(2), Stream.runCollect);
				}),
				layer,
			),
		);
		// Allow the subscriber to register before emitting.
		await new Promise((r) => setTimeout(r, 10));
		controls.emit("/dir", { type: "rename", file: "x.json" });
		controls.emit("/dir", { type: "change", file: "x.json" });
		const events = Array.from(await collectedPromise);
		assert.equal(events.length, 2);
		assert.equal(events[0]?.type, "rename");
		assert.equal(events[1]?.type, "change");
	});
});
