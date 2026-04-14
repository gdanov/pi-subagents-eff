/**
 * Tests for src/services/SessionStore.ts.
 *
 * Verifies subagentSessionRoot derivation and findLatest behavior.
 * subagentSessionRoot's mkdtemp branch uses real fs (no FileSystem
 * abstraction for it), so we test the parent-session-file branch
 * deterministically and only smoke-test the mkdtemp branch.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import { SessionStore, SessionStoreLive } from "../../src/services/SessionStore.ts";
import { FileSystem, makeFileSystemTest } from "../../src/services/FileSystem.ts";

const cleanupDirs: string[] = [];

afterEach(() => {
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("SessionStore.subagentSessionRoot", () => {
	it("derives sessionsDir/baseName when given a parent session file", async () => {
		const fsTest = makeFileSystemTest();
		const layer = Layer.provide(SessionStoreLive, fsTest.layer);
		const root = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const store = yield* SessionStore;
					return yield* store.subagentSessionRoot("/sessions/abc.jsonl");
				}),
				layer,
			),
		);
		assert.equal(root, "/sessions/abc");
	});

	it("falls back to mkdtemp when no parent session", async () => {
		const fsTest = makeFileSystemTest();
		const layer = Layer.provide(SessionStoreLive, fsTest.layer);
		const root = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const store = yield* SessionStore;
					return yield* store.subagentSessionRoot(null);
				}),
				layer,
			),
		);
		cleanupDirs.push(root);
		assert.match(path.basename(root), /^pi-subagent-session-/);
		assert.ok(fs.existsSync(root));
	});
});

describe("SessionStore.findLatest", () => {
	it("returns undefined for missing dir", async () => {
		const fsTest = makeFileSystemTest();
		const layer = Layer.provide(SessionStoreLive, fsTest.layer);
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const store = yield* SessionStore;
					return yield* store.findLatest("/missing");
				}),
				layer,
			),
		);
		assert.equal(result, undefined);
	});

	it("returns undefined when dir has no .jsonl files", async () => {
		const fsTest = makeFileSystemTest({ "/dir/x.txt": "x", "/dir/y.md": "y" });
		const layer = Layer.provide(SessionStoreLive, fsTest.layer);
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const store = yield* SessionStore;
					return yield* store.findLatest("/dir");
				}),
				layer,
			),
		);
		assert.equal(result, undefined);
	});

	it("picks the most recently modified .jsonl", async () => {
		// In-memory FS stamps mtime at write-time using Date.now(); write
		// in order so the last write wins.
		const fsTest = makeFileSystemTest();
		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const fsApi = yield* FileSystem;
					yield* fsApi.write("/d/old.jsonl", "{}");
					yield* Effect.sleep("20 millis");
					yield* fsApi.write("/d/new.jsonl", "{}");
				}),
				fsTest.layer,
			),
		);
		const layer = Layer.provide(SessionStoreLive, fsTest.layer);
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const store = yield* SessionStore;
					return yield* store.findLatest("/d");
				}),
				layer,
			),
		);
		assert.equal(result, "/d/new.jsonl");
	});
});
