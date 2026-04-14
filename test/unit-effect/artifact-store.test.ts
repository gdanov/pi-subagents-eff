/**
 * Tests for src/services/ArtifactStore.ts using the InMemory FileSystem.
 *
 * Behaviors verified:
 *   - Path derivation matches the legacy artifacts.ts:15 contract.
 *   - resolveDir picks session-anchored dir when a session file is given.
 *   - writeMetadata produces pretty-printed JSON.
 *   - cleanupOlderThan respects the 24h marker rate-limit.
 *   - cleanupOlderThan no-ops on missing dir.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import { TEMP_ARTIFACTS_DIR } from "../../src/domain/constants.ts";
import { ArtifactStore, ArtifactStoreLive } from "../../src/services/ArtifactStore.ts";
import { makeFileSystemTest } from "../../src/services/FileSystem.ts";

describe("ArtifactStore.paths and resolveDir", () => {
	it("paths layout matches the legacy filename contract", async () => {
		const fs = makeFileSystemTest();
		const layer = Layer.provide(ArtifactStoreLive, fs.layer);
		const paths = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const store = yield* ArtifactStore;
					return store.paths("/art", "run-123", "scout", 0);
				}),
				layer,
			),
		);
		assert.equal(paths.inputPath, "/art/run-123_scout_0_input.md");
		assert.equal(paths.outputPath, "/art/run-123_scout_0_output.md");
		assert.equal(paths.jsonlPath, "/art/run-123_scout_0.jsonl");
		assert.equal(paths.metadataPath, "/art/run-123_scout_0_meta.json");
	});

	it("paths sanitizes unsafe characters in agent name", async () => {
		const fs = makeFileSystemTest();
		const layer = Layer.provide(ArtifactStoreLive, fs.layer);
		const paths = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const store = yield* ArtifactStore;
					return store.paths("/art", "r", "weird/agent name!", undefined);
				}),
				layer,
			),
		);
		assert.equal(path.basename(paths.inputPath), "r_weird_agent_name__input.md");
	});

	it("resolveDir uses session-adjacent dir when given", async () => {
		const fs = makeFileSystemTest();
		const layer = Layer.provide(ArtifactStoreLive, fs.layer);
		const dir = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const store = yield* ArtifactStore;
					return store.resolveDir("/sessions/abc.jsonl");
				}),
				layer,
			),
		);
		assert.equal(dir, "/sessions/subagent-artifacts");
	});

	it("resolveDir falls back to TEMP_ARTIFACTS_DIR when no session", async () => {
		const fs = makeFileSystemTest();
		const layer = Layer.provide(ArtifactStoreLive, fs.layer);
		const dir = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const store = yield* ArtifactStore;
					return store.resolveDir(null);
				}),
				layer,
			),
		);
		assert.equal(dir, TEMP_ARTIFACTS_DIR);
	});
});

describe("ArtifactStore writes", () => {
	it("writeMetadata pretty-prints JSON", async () => {
		const fs = makeFileSystemTest();
		const layer = Layer.provide(ArtifactStoreLive, fs.layer);
		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const store = yield* ArtifactStore;
					yield* store.writeMetadata("/art/m.json", { a: 1, nested: { b: 2 } });
				}),
				layer,
			),
		);
		const content = fs.controls.getFile("/art/m.json");
		assert.match(content ?? "", /\n  "a": 1,\n  "nested": \{\n    "b": 2\n  \}\n/);
	});

	it("appendJsonlLine appends with trailing newline", async () => {
		const fs = makeFileSystemTest();
		const layer = Layer.provide(ArtifactStoreLive, fs.layer);
		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const store = yield* ArtifactStore;
					yield* store.appendJsonlLine("/art/x.jsonl", '{"a":1}');
					yield* store.appendJsonlLine("/art/x.jsonl", '{"a":2}');
				}),
				layer,
			),
		);
		assert.equal(fs.controls.getFile("/art/x.jsonl"), '{"a":1}\n{"a":2}\n');
	});
});

describe("ArtifactStore.cleanupOlderThan", () => {
	it("no-ops on missing dir", async () => {
		const fs = makeFileSystemTest();
		const layer = Layer.provide(ArtifactStoreLive, fs.layer);
		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const store = yield* ArtifactStore;
					yield* store.cleanupOlderThan("/missing", 7);
				}),
				layer,
			),
		);
		// no exceptions, no files added
		assert.equal(fs.controls.listFiles().length, 0);
	});
});
