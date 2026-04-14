/**
 * Tests for src/services/GitSpawner.ts.
 *
 * Test layer: script-driven handler list, verify calls are recorded
 * and runChecked maps non-zero exit to GitWorktreeError.
 *
 * Live layer: smoke test against a throwaway real git repo in tmpdir
 * — exercises the actual spawnSync path for `git init`-ish baseline
 * operations. Skipped if `git` isn't on PATH.
 */
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Cause, Effect, Exit, Option } from "effect";
import { GitWorktreeError } from "../../src/errors.ts";
import {
	GitSpawner,
	GitSpawnerLive,
	makeGitSpawnerTest,
} from "../../src/services/GitSpawner.ts";

function hasGit(): boolean {
	const r = spawnSync("git", ["--version"], { encoding: "utf-8" });
	return r.status === 0;
}

describe("GitSpawner Test layer", () => {
	it("runChecked succeeds when handler returns status 0", async () => {
		const test = makeGitSpawnerTest([
			{
				match: (_cwd, args) => args[0] === "rev-parse",
				reply: { stdout: "abc123\n", stderr: "", status: 0 },
			},
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const git = yield* GitSpawner;
					return yield* git.runChecked("list", "/repo", ["rev-parse", "HEAD"]);
				}),
				test.layer,
			),
		);
		assert.equal(out.trim(), "abc123");
		assert.equal(test.calls().length, 1);
		assert.deepEqual([...test.calls()[0]!.args], ["rev-parse", "HEAD"]);
	});

	it("runChecked fails with GitWorktreeError on non-zero status", async () => {
		const test = makeGitSpawnerTest([
			{ match: () => true, reply: { stdout: "", stderr: "bad", status: 1 } },
		]);
		const exit = await Effect.runPromiseExit(
			Effect.provide(
				Effect.gen(function* () {
					const git = yield* GitSpawner;
					return yield* git.runChecked("add", "/repo", ["worktree", "add", "/tmp/wt"]);
				}),
				test.layer,
			),
		);
		if (Exit.isFailure(exit)) {
			const err = Cause.findErrorOption(exit.cause);
			if (Option.isSome(err)) {
				assert.ok(err.value instanceof GitWorktreeError);
				assert.equal(err.value.operation, "add");
				assert.equal(err.value.stderr, "bad");
			}
		} else {
			assert.fail("expected failure");
		}
	});

	it("run returns status 1 with a helpful message when no handler matches", async () => {
		const test = makeGitSpawnerTest([]);
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const git = yield* GitSpawner;
					return yield* git.run("/repo", ["unknown"]);
				}),
				test.layer,
			),
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /no handler matched/);
	});

	it("assertCleanRepo returns synthetic repo state", async () => {
		const test = makeGitSpawnerTest([]);
		const repo = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const git = yield* GitSpawner;
					return yield* git.assertCleanRepo("/anywhere");
				}),
				test.layer,
			),
		);
		assert.equal(repo.toplevel, "/fake-repo");
		assert.equal(repo.baseCommit, "fakehash");
	});
});

describe("GitSpawnerLive (real git)", { skip: !hasGit() ? "git not on PATH" : undefined }, () => {
	let repoDir: string | null = null;

	afterEach(() => {
		if (repoDir) {
			fs.rmSync(repoDir, { recursive: true, force: true });
			repoDir = null;
		}
	});

	function initRepo(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-git-test-"));
		execSync("git init -q", { cwd: dir });
		execSync('git config user.email "t@example.com"', { cwd: dir });
		execSync('git config user.name "Test"', { cwd: dir });
		fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
		execSync("git add README.md", { cwd: dir });
		execSync('git commit -q -m "init"', { cwd: dir });
		return dir;
	}

	it("run returns stdout for a successful rev-parse", async () => {
		repoDir = initRepo();
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const git = yield* GitSpawner;
					return yield* git.run(repoDir!, ["rev-parse", "HEAD"]);
				}),
				GitSpawnerLive,
			),
		);
		assert.equal(result.status, 0);
		assert.match(result.stdout.trim(), /^[0-9a-f]{40}$/);
	});

	it("assertCleanRepo succeeds on a clean repo and fails on a dirty one", async () => {
		repoDir = initRepo();
		const clean = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const git = yield* GitSpawner;
					return yield* git.assertCleanRepo(repoDir!);
				}),
				GitSpawnerLive,
			),
		);
		assert.equal(clean.toplevel, fs.realpathSync(repoDir));
		assert.match(clean.baseCommit, /^[0-9a-f]{40}$/);

		// Dirty the repo.
		fs.writeFileSync(path.join(repoDir, "README.md"), "changed\n");
		const dirtyExit = await Effect.runPromiseExit(
			Effect.provide(
				Effect.gen(function* () {
					const git = yield* GitSpawner;
					return yield* git.assertCleanRepo(repoDir!);
				}),
				GitSpawnerLive,
			),
		);
		assert.equal(Exit.isFailure(dirtyExit), true);
	});

	it("assertCleanRepo fails outside a git work-tree", async () => {
		const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-non-git-"));
		try {
			const exit = await Effect.runPromiseExit(
				Effect.provide(
					Effect.gen(function* () {
						const git = yield* GitSpawner;
						return yield* git.assertCleanRepo(nonRepo);
					}),
					GitSpawnerLive,
				),
			);
			if (Exit.isFailure(exit)) {
				const err = Cause.findErrorOption(exit.cause);
				if (Option.isSome(err)) {
					assert.ok(err.value instanceof GitWorktreeError);
					assert.match(err.value.stderr, /requires a git repository/);
				}
			} else {
				assert.fail("expected failure");
			}
		} finally {
			fs.rmSync(nonRepo, { recursive: true, force: true });
		}
	});
});
