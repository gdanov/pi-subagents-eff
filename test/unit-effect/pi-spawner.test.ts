/**
 * Tests for src/services/PiSpawner.ts.
 *
 * Three surfaces covered:
 *   1. `getPiSpawnCommand` pure helper — parity with test/unit/pi-spawn.test.ts.
 *   2. Live `spawnPi` against a real child process (node -e "...")
 *      — exercises the stdout line splitter + the exit event.
 *   3. Test layer — scripted events and spawn-count tracking.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Stream } from "effect";
import {
	getPiSpawnCommand,
	makePiSpawnerTest,
	PiSpawner,
	PiSpawnerLive,
	type PiEvent,
	type PiSpawnDeps,
} from "../../src/services/PiSpawner.ts";

function makeDeps(input: {
	argv1?: string;
	existing?: ReadonlyArray<string>;
	packageJsonPath?: string;
	packageJsonContent?: string;
	execPath?: string;
}): PiSpawnDeps {
	const existing = new Set(input.existing ?? []);
	return {
		execPath: input.execPath,
		argv1: input.argv1,
		existsSync: (p) => existing.has(p),
		readFileSync: () => input.packageJsonContent ?? "",
		resolvePackageJson: () => {
			if (!input.packageJsonPath) throw new Error("no package json configured");
			return input.packageJsonPath;
		},
	};
}

describe("getPiSpawnCommand", () => {
	it("uses node + argv1 when argv1 is a runnable JS file", () => {
		const result = getPiSpawnCommand(["--mode", "json"], {
			execPath: "/usr/local/bin/node",
			argv1: "/tmp/pi-entry.mjs",
			existsSync: (p) => p === "/tmp/pi-entry.mjs",
		});
		assert.equal(result.command, "/usr/local/bin/node");
		assert.deepEqual([...result.args], ["/tmp/pi-entry.mjs", "--mode", "json"]);
	});

	it("resolves CLI script from package bin when argv1 is not runnable", () => {
		const binPath = "/opt/pi/dist/cli.js";
		const packageJsonPath = "/opt/pi/package.json";
		const deps = makeDeps({
			execPath: "/usr/local/bin/node",
			argv1: "/usr/local/bin/pi",
			existing: [binPath],
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: { pi: "dist/cli.js" } }),
		});
		const result = getPiSpawnCommand(["arg"], deps);
		assert.equal(result.command, "/usr/local/bin/node");
		assert.deepEqual([...result.args], [binPath, "arg"]);
	});

	it("falls back to bare pi when no script is resolvable", () => {
		const result = getPiSpawnCommand(["x"], {
			argv1: "/usr/bin/unknown",
			existsSync: () => false,
			resolvePackageJson: () => {
				throw new Error("none");
			},
		});
		assert.equal(result.command, "pi");
		assert.deepEqual([...result.args], ["x"]);
	});
});

describe("PiSpawnerLive (real child process)", () => {
	it("emits stdout lines and a final exit event", async () => {
		const script = 'process.stdout.write("line1\\nline2\\n"); process.exit(0);';
		const events = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const spawner = yield* PiSpawner;
					return yield* spawner
						.spawnPi({
							command: process.execPath,
							args: ["-e", script],
						})
						.pipe(Stream.runCollect);
				}),
				PiSpawnerLive,
			),
		);
		const arr = Array.from(events) as PiEvent[];
		const stdoutLines = arr.filter((e) => e.type === "stdout").map((e) => (e as { line: string }).line);
		const exit = arr.find((e) => e.type === "exit") as
			| { type: "exit"; code: number; signal: NodeJS.Signals | null }
			| undefined;
		assert.deepEqual(stdoutLines, ["line1", "line2"]);
		assert.ok(exit);
		assert.equal(exit?.code, 0);
	});

	it("surfaces stderr chunks and a non-zero exit code", async () => {
		const script = 'process.stderr.write("oops\\n"); process.exit(2);';
		const events = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const spawner = yield* PiSpawner;
					return yield* spawner
						.spawnPi({
							command: process.execPath,
							args: ["-e", script],
						})
						.pipe(Stream.runCollect);
				}),
				PiSpawnerLive,
			),
		);
		const arr = Array.from(events) as PiEvent[];
		const stderr = arr.filter((e) => e.type === "stderr").map((e) => (e as { data: string }).data).join("");
		const exit = arr.find((e) => e.type === "exit") as
			| { type: "exit"; code: number; signal: NodeJS.Signals | null }
			| undefined;
		assert.match(stderr, /oops/);
		assert.equal(exit?.code, 2);
	});

	it("flushes a trailing line that lacks a newline", async () => {
		// Print 'tail' with no \n, then exit. The splitter should flush
		// the residual buffer at close.
		const script = 'process.stdout.write("tail"); process.exit(0);';
		const events = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const spawner = yield* PiSpawner;
					return yield* spawner
						.spawnPi({
							command: process.execPath,
							args: ["-e", script],
						})
						.pipe(Stream.runCollect);
				}),
				PiSpawnerLive,
			),
		);
		const lines = (Array.from(events) as PiEvent[])
			.filter((e) => e.type === "stdout")
			.map((e) => (e as { line: string }).line);
		assert.deepEqual(lines, ["tail"]);
	});
});

describe("PiSpawner Test layer", () => {
	it("returns scripted events and tracks spawn count + spec", async () => {
		const test = makePiSpawnerTest([
			{ events: [{ type: "stdout", line: "a" }, { type: "exit", code: 0, signal: null }] },
			{ events: [{ type: "stdout", line: "b" }, { type: "exit", code: 0, signal: null }] },
		]);
		const [first, second] = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const spawner = yield* PiSpawner;
					const a = yield* spawner
						.spawnPi({ command: "pi", args: ["x"] })
						.pipe(Stream.runCollect);
					const b = yield* spawner
						.spawnPi({ command: "pi", args: ["y"] })
						.pipe(Stream.runCollect);
					return [Array.from(a), Array.from(b)] as const;
				}),
				test.layer,
			),
		);
		assert.equal(first.length, 2);
		assert.equal(second.length, 2);
		assert.equal(test.controls.spawnCount(), 2);
		assert.deepEqual([...(test.controls.lastSpec()?.args ?? [])], ["y"]);
	});

	it("fails with PiSpawnError when the script is exhausted", async () => {
		const test = makePiSpawnerTest([]);
		const exit = await Effect.runPromiseExit(
			Effect.provide(
				Effect.gen(function* () {
					const spawner = yield* PiSpawner;
					return yield* spawner
						.spawnPi({ command: "pi", args: [] })
						.pipe(Stream.runCollect);
				}),
				test.layer,
			),
		);
		assert.equal(exit._tag, "Failure");
	});
});
